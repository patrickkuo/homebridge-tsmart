import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { deviceIdsMatch, deviceNamesMatch } from './deviceMatch.js';
import { clampSetpoint, presentHeater } from './heaterPresentation.js';
import type { TSmartPlatform } from './platform.js';
import { SerialQueue } from './serialQueue.js';
import {
  AFTER_CONTROL_REFRESH_MS,
  MAX_STATUS_FAILURES,
  POLL_INTERVAL_MS,
  TEMP_MAX,
  TEMP_MIN,
  TEMP_STEP,
} from './settings.js';
import { StatusCoordinator } from './statusCoordinator.js';
import { sleep, TSmartClient, TSmartMode, type TSmartStatus } from './tsmart.js';
import { parseDeviceConfig, type TSmartDeviceConfig } from './types.js';

/**
 * One T-Smart heater as a HomeKit HeaterCooler (+ Low TemperatureSensor).
 *
 * Heater current temp is always the High probe (device display). Low is a
 * separate thermometer. Apple Home controls Off/Heat + setpoint only; every
 * HomeKit write uses Manual mode.
 *
 * Concurrency model:
 * - Global UDP lock lives in TSmartClient (port 1337)
 * - Per-accessory controlQueue paces writes + ~2s settle (HA-like)
 * - Per-accessory refreshQueue serializes polls
 * - StatusCoordinator (generation + controlInFlight) drops stale poll results
 *
 * Reachability: GETs require live status and fail after repeated poll errors so
 * HomeKit can show Not Responding. SETs refresh companion fields (power/setpoint)
 * from the device when needed, then write. Parked accessories reject both.
 */
export class TSmartPlatformAccessory {
  private device: TSmartDeviceConfig;
  private client: TSmartClient;
  private readonly heaterService: Service;
  private readonly lowTempService: Service;
  private readonly sync = new StatusCoordinator();
  private readonly controlQueue = new SerialQueue();
  private readonly refreshQueue = new SerialQueue();

  private status: TSmartStatus = {
    power: false,
    setpoint: 55,
    mode: TSmartMode.Manual,
    temperatureHigh: 55,
    temperatureLow: 55,
    temperatureAverage: 55,
    relay: false,
  };

  private pollTimer?: ReturnType<typeof setInterval>;
  private destroyed = false;
  /** True after at least one successful status read (or successful control). */
  private hasLiveStatus = false;
  private consecutiveFailures = 0;
  /** True when another live heater currently owns our last-known IP. */
  private parkedForIpConflict = false;

  constructor(
    private readonly platform: TSmartPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const device = parseDeviceConfig(accessory.context.device);
    if (!device) {
      throw new Error(`Invalid device context on accessory ${accessory.displayName}`);
    }
    this.device = device;
    this.client = new TSmartClient(this.device.ip, this.platform.log);

    this.accessory.displayName = this.device.name;

    // Drop legacy mode switches / duplicate High sensors from older plugin versions.
    for (const service of [...this.accessory.services]) {
      const subtype = service.subtype ?? '';
      if (subtype.startsWith('mode-') || subtype === 'temp-high') {
        this.accessory.removeService(service);
      }
    }

    const info =
      this.accessory.getService(this.platform.Service.AccessoryInformation) ||
      this.accessory.addService(this.platform.Service.AccessoryInformation);
    info
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'EUROICC')
      .setCharacteristic(this.platform.Characteristic.Model, 'T-Smart')
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.device.deviceId ?? this.device.ip,
      );

    this.heaterService =
      this.accessory.getServiceById(this.platform.Service.HeaterCooler, 'heater') ||
      this.accessory.getService(this.platform.Service.HeaterCooler) ||
      this.accessory.addService(
        this.platform.Service.HeaterCooler,
        this.device.name,
        'heater',
      );

    this.setServiceName(this.heaterService, this.device.name);

    this.heaterService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.handleActiveGet.bind(this))
      .onSet(this.handleActiveSet.bind(this));

    this.heaterService
      .getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(this.handleCurrentStateGet.bind(this));

    this.heaterService
      .getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({
        validValues: [this.platform.Characteristic.TargetHeaterCoolerState.HEAT],
      })
      // Heat-only water heater: target is always HEAT; Active controls power.
      .onGet(this.handleTargetStateGet.bind(this));

    this.heaterService
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .setProps({ minValue: 0, maxValue: 100, minStep: 0.1 })
      .onGet(this.handleCurrentTemperatureGet.bind(this));

    this.heaterService
      .getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: TEMP_MIN, maxValue: TEMP_MAX, minStep: TEMP_STEP })
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(this.handleTargetTemperatureSet.bind(this));

    this.lowTempService =
      this.accessory.getServiceById(this.platform.Service.TemperatureSensor, 'temp-low') ||
      this.accessory.addService(this.platform.Service.TemperatureSensor, 'Low', 'temp-low');
    this.setServiceName(this.lowTempService, 'Low');
    this.lowTempService
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .setProps({ minValue: 0, maxValue: 100, minStep: 0.1 })
      .onGet(this.handleLowTemperatureGet.bind(this));

    void this.enqueueRefresh();
    this.pollTimer = setInterval(() => {
      void this.enqueueRefresh();
    }, POLL_INTERVAL_MS);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.sync.invalidate();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /** Stop polling a stale IP that now belongs to a different heater. */
  parkForIpConflict(): void {
    const alreadyParked = this.parkedForIpConflict;
    this.parkedForIpConflict = true;
    this.hasLiveStatus = false;
    this.consecutiveFailures = MAX_STATUS_FAILURES;
    // Drop in-flight poll/control results so they cannot refresh a parked tile.
    this.sync.invalidate();
    if (!alreadyParked) {
      this.platform.requestRediscovery();
    }
  }

  /**
   * Rebind after rediscovery (IP change) or merge learned deviceId / name.
   * Same HomeKit accessory UUID is preserved.
   */
  updateEndpoint(next: TSmartDeviceConfig): void {
    if (this.destroyed || !this.canAcceptEndpoint(next)) {
      return;
    }

    this.parkedForIpConflict = false;

    const ipChanged = next.ip !== this.device.ip;
    const idChanged = Boolean(next.deviceId) && !deviceIdsMatch(next.deviceId, this.device.deviceId);
    const nameChanged = next.name !== this.device.name;

    this.device = {
      ...this.device,
      ...next,
      deviceId: next.deviceId ?? this.device.deviceId,
    };
    this.accessory.context.device = this.device;

    if (nameChanged) {
      this.accessory.displayName = this.device.name;
      this.setServiceName(this.heaterService, this.device.name);
    }

    this.accessory
      .getService(this.platform.Service.AccessoryInformation)
      ?.setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.device.deviceId ?? this.device.ip,
      );

    this.platform.api.updatePlatformAccessories([this.accessory]);

    if (ipChanged) {
      this.platform.log.info(
        'Rebound %s to new IP %s (was %s)',
        this.device.name,
        next.ip,
        this.client.ipAddress,
      );
      this.sync.invalidate();
      this.hasLiveStatus = false;
      this.status = {
        power: false,
        setpoint: 55,
        mode: TSmartMode.Manual,
        temperatureHigh: 55,
        temperatureLow: 55,
        temperatureAverage: 55,
        relay: false,
      };
      this.client = new TSmartClient(next.ip, this.platform.log);
      this.consecutiveFailures = 0;
      void this.enqueueRefresh();
    } else if (idChanged) {
      this.platform.log.debug(
        'Learned device id %s for %s',
        this.device.deviceId,
        this.device.name,
      );
    }
  }

  /** Refuse to unpark / rebind onto a different heater identity. */
  private canAcceptEndpoint(next: TSmartDeviceConfig): boolean {
    if (!this.parkedForIpConflict) {
      return true;
    }

    if (this.device.deviceId) {
      if (next.deviceId) {
        return deviceIdsMatch(this.device.deviceId, next.deviceId);
      }
      return deviceNamesMatch(this.device.name, next.name);
    }

    // IP-only parked accessory: never adopt a foreign deviceId at the same
    // conflicted IP. Allow reclaim only after an IP move with matching name.
    if (next.deviceId) {
      return next.ip !== this.device.ip && deviceNamesMatch(this.device.name, next.name);
    }
    return deviceNamesMatch(this.device.name, next.name);
  }

  private assertReachable(): void {
    if (
      this.parkedForIpConflict ||
      !this.hasLiveStatus ||
      this.consecutiveFailures >= MAX_STATUS_FAILURES
    ) {
      throw this.hapCommunicationError();
    }
  }

  private invalidValue(): never {
    throw new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST,
    );
  }

  private hapCommunicationError(): InstanceType<typeof this.platform.api.hap.HapStatusError> {
    return new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  }

  private clampDeviceSetpoint(value: number): number {
    return clampSetpoint(value, TEMP_MIN, TEMP_MAX, TEMP_STEP);
  }

  private setServiceName(service: Service, name: string): void {
    service.setCharacteristic(this.platform.Characteristic.Name, name);
    try {
      service.setCharacteristic(this.platform.Characteristic.ConfiguredName, name);
    } catch {
      // Some service types / HAP builds reject ConfiguredName.
    }
  }

  private async handleActiveGet(): Promise<CharacteristicValue> {
    this.assertReachable();
    const { active } = presentHeater(this.status, this.clampDeviceSetpoint.bind(this));
    return active
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  private async handleActiveSet(value: CharacteristicValue): Promise<void> {
    const power = value === this.platform.Characteristic.Active.ACTIVE;
    this.platform.log.info('Set Active → %s (%s)', power ? 'ON' : 'OFF', this.device.name);
    // Keep the device setpoint; resolve it inside applyControl after a fresh read if needed.
    await this.applyControl({ power });
  }

  private async handleCurrentStateGet(): Promise<CharacteristicValue> {
    this.assertReachable();
    const { currentState } = presentHeater(this.status, this.clampDeviceSetpoint.bind(this));
    switch (currentState) {
      case 'heating':
        return this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
      case 'idle':
        return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
      case 'inactive':
      default:
        return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }
  }

  private async handleTargetStateGet(): Promise<CharacteristicValue> {
    this.assertReachable();
    return this.platform.Characteristic.TargetHeaterCoolerState.HEAT;
  }

  private async handleCurrentTemperatureGet(): Promise<CharacteristicValue> {
    this.assertReachable();
    return presentHeater(this.status, this.clampDeviceSetpoint.bind(this)).currentTemperature;
  }

  private async handleLowTemperatureGet(): Promise<CharacteristicValue> {
    this.assertReachable();
    return this.status.temperatureLow;
  }

  private async handleTargetTemperatureGet(): Promise<CharacteristicValue> {
    this.assertReachable();
    return presentHeater(this.status, this.clampDeviceSetpoint.bind(this)).targetTemperature;
  }

  private async handleTargetTemperatureSet(value: CharacteristicValue): Promise<void> {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      this.invalidValue();
    }
    const setpoint = this.clampDeviceSetpoint(numeric);
    this.platform.log.info('Set target temperature → %s°C (%s)', setpoint, this.device.name);
    // Keep the device power state; resolve it inside applyControl after a fresh read if needed.
    await this.applyControl({ setpoint });
  }

  /**
   * Serialize controls on controlQueue. Ack HomeKit after UDP controlSet succeeds,
   * then keep the queue busy for settle + refresh so the next write is HA-paced
   * (HomeKit promise resolves before settle finishes).
   *
   * Omitted fields are taken from live device status (refreshed when needed) so
   * we never write the hardcoded startup defaults for power/setpoint.
   */
  private applyControl(update: { power?: boolean; setpoint?: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      void this.controlQueue.enqueue(async () => {
        if (this.isInactive()) {
          reject(this.hapCommunicationError());
          return;
        }

        const gen = this.sync.beginControl();

        try {
          if (!(await this.confirmEndpointIdentity()) || !this.controlStillCurrent(gen)) {
            reject(this.hapCommunicationError());
            return;
          }

          if (!this.hasLiveStatus) {
            const status = await this.client.getStatus();
            if (!this.controlStillCurrent(gen)) {
              reject(this.hapCommunicationError());
              return;
            }
            this.status = status;
            this.markLive();
          }

          const power = update.power ?? this.status.power;
          const setpoint = update.setpoint ?? this.status.setpoint;
          // HomeKit writes always use Manual; leave Eco/Smart/etc. to the device UI.
          const mode = TSmartMode.Manual;

          await this.client.controlSet(power, mode, setpoint);
          if (!this.controlStillCurrent(gen)) {
            reject(this.hapCommunicationError());
            return;
          }

          this.status = { ...this.status, power, mode, setpoint };
          this.markLive();
          this.publishCharacteristics();
          resolve();

          await sleep(AFTER_CONTROL_REFRESH_MS);
          if (this.sync.shouldApplyControlRefresh(gen)) {
            await this.fetchAndApplyStatus(gen);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.platform.log.error('Control failed for %s: %s', this.device.name, message);
          reject(this.hapCommunicationError());
        } finally {
          this.sync.endControl(gen);
        }
      });
    });
  }

  private enqueueRefresh(): Promise<void> {
    if (this.isInactive() || this.sync.controlInFlight) {
      return Promise.resolve();
    }

    return this.refreshQueue.enqueue(async () => {
      if (this.isInactive() || this.sync.controlInFlight) {
        return;
      }
      await this.fetchAndApplyStatus();
    });
  }

  /**
   * @param requiredGen - When set (post-control refresh), only apply if this
   *   generation is still current. When omitted (poll), discard if generation
   *   changed during the UDP round-trip or a control started.
   */
  private async fetchAndApplyStatus(requiredGen?: number): Promise<void> {
    const genAtStart = this.sync.generation;
    try {
      const status = await this.client.getStatus();
      if (!this.canApplyStatus(genAtStart, requiredGen)) {
        return;
      }

      // Confirm the host at this IP is still this heater before publishing.
      if (!(await this.confirmEndpointIdentity()) || !this.canApplyStatus(genAtStart, requiredGen)) {
        return;
      }

      this.status = status;
      this.markLive();
      this.publishCharacteristics();
    } catch (error) {
      if (this.isInactive()) {
        return;
      }
      this.consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      this.platform.log.warn(
        'Status refresh failed for %s (%d/%d): %s',
        this.device.name,
        this.consecutiveFailures,
        MAX_STATUS_FAILURES,
        message,
      );
      if (this.consecutiveFailures >= MAX_STATUS_FAILURES) {
        this.platform.requestRediscovery();
      }
    }
  }

  private isInactive(): boolean {
    return this.destroyed || this.parkedForIpConflict;
  }

  private markLive(): void {
    this.hasLiveStatus = true;
    this.consecutiveFailures = 0;
  }

  private controlStillCurrent(gen: number): boolean {
    return !this.isInactive() && this.sync.shouldApplyControlRefresh(gen);
  }

  private canApplyStatus(genAtStart: number, requiredGen?: number): boolean {
    if (this.isInactive()) {
      return false;
    }
    if (requiredGen !== undefined) {
      return this.sync.shouldApplyControlRefresh(requiredGen);
    }
    return this.sync.shouldApplyPollResult(genAtStart);
  }

  /**
   * Verify (and optionally learn) identity via 0x21.
   * Returns false when the endpoint is not this heater (caller must not apply).
   */
  private async confirmEndpointIdentity(): Promise<boolean> {
    if (this.isInactive()) {
      return false;
    }

    const identity = await this.client.getIdentity();
    if (this.isInactive()) {
      return false;
    }

    if (this.device.deviceId) {
      if (!deviceIdsMatch(this.device.deviceId, identity.deviceId)) {
        this.platform.log.warn(
          'Identity mismatch for "%s": expected id %s, got %s at %s — parking',
          this.device.name,
          this.device.deviceId,
          identity.deviceId,
          this.device.ip,
        );
        this.parkForIpConflict();
        return false;
      }
      return true;
    }

    // IP-only: require the device-reported name to match before applying or learning.
    if (!deviceNamesMatch(this.device.name, identity.name)) {
      this.platform.log.warn(
        'Name mismatch at %s: configured "%s", device reports "%s" — parking',
        this.device.ip,
        this.device.name,
        identity.name,
      );
      this.parkForIpConflict();
      return false;
    }

    this.learnDeviceId(identity.deviceId);
    return !this.parkedForIpConflict;
  }

  /** Promote an IP-only accessory after a matching 0x21 read; persist into config.json. */
  private learnDeviceId(deviceId: string): void {
    if (this.device.deviceId || this.isInactive()) {
      return;
    }
    this.device = { ...this.device, deviceId };
    this.accessory.context.device = this.device;
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)
      ?.setCharacteristic(this.platform.Characteristic.SerialNumber, deviceId);
    this.platform.api.updatePlatformAccessories([this.accessory]);
    this.platform.persistLearnedDeviceId({
      name: this.device.name,
      ip: this.device.ip,
      deviceId,
    });
    this.platform.log.debug('Learned device id %s for %s', deviceId, this.device.name);
  }

  private publishCharacteristics(): void {
    const { Characteristic } = this.platform;
    const view = presentHeater(this.status, this.clampDeviceSetpoint.bind(this));

    this.heaterService.updateCharacteristic(
      Characteristic.Active,
      view.active ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
    );

    this.heaterService.updateCharacteristic(
      Characteristic.CurrentHeaterCoolerState,
      view.currentState === 'heating'
        ? Characteristic.CurrentHeaterCoolerState.HEATING
        : view.currentState === 'idle'
          ? Characteristic.CurrentHeaterCoolerState.IDLE
          : Characteristic.CurrentHeaterCoolerState.INACTIVE,
    );

    this.heaterService.updateCharacteristic(
      Characteristic.TargetHeaterCoolerState,
      Characteristic.TargetHeaterCoolerState.HEAT,
    );

    this.heaterService.updateCharacteristic(
      Characteristic.CurrentTemperature,
      view.currentTemperature,
    );

    this.heaterService.updateCharacteristic(
      Characteristic.HeatingThresholdTemperature,
      view.targetTemperature,
    );

    this.lowTempService.updateCharacteristic(
      Characteristic.CurrentTemperature,
      this.status.temperatureLow,
    );
  }
}
