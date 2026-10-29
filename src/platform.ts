import { watch, type FSWatcher } from 'node:fs';

import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import {
  ensureCachedDeviceInConfig,
  persistLearnedDeviceId as writeLearnedDeviceId,
  readTSmartPlatformConfig,
} from './configStore.js';
import {
  deviceIdsMatch,
  deviceNamesMatch,
  normalizeDeviceName,
} from './deviceMatch.js';
import { TSmartPlatformAccessory } from './platformAccessory.js';
import {
  CONFIG_WATCH_DEBOUNCE_MS,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from './settings.js';
import {
  isDeviceEnabled,
  parseDeviceConfig,
  type TSmartDeviceConfig,
} from './types.js';

export type { TSmartDeviceConfig } from './types.js';

export interface TSmartPlatformConfig extends PlatformConfig {
  name?: string;
  devices?: TSmartDeviceConfig[];
}

/**
 * Homebridge dynamic platform for T-Smart / EUROICC water heaters.
 *
 * Network discovery is done from the custom settings UI (Scan button).
 * This platform only binds enabled devices from config (and applies Saves
 * live by watching config.json).
 */
export class TSmartPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories = new Map<string, PlatformAccessory>();
  private readonly handlers = new Map<string, TSmartPlatformAccessory>();

  private reconcileInFlight = false;
  private reconcilePending = false;
  private shuttingDown = false;
  private configWatcher?: FSWatcher;
  private configWatchDebounce?: ReturnType<typeof setTimeout>;
  private ignoreConfigWatchUntil = 0;

  constructor(
    public readonly log: Logging,
    public readonly config: TSmartPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.startConfigWatch();
      void this.reconcile();
    });

    this.api.on('shutdown', () => {
      this.shuttingDown = true;
      this.stopConfigWatch();
      for (const handler of this.handlers.values()) {
        handler.destroy();
      }
      this.handlers.clear();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  /** Kept for accessory poll-failure hooks; discovery is UI-driven. */
  requestRediscovery(): void {
    this.log.debug(
      'Skipping automatic rediscovery — open plugin Settings to rescan',
    );
  }

  /** Write a runtime-learned deviceId onto the matching config.json row. */
  persistLearnedDeviceId(learned: { name: string; ip: string; deviceId: string }): void {
    try {
      this.suppressConfigWatch(3_000);
      const wrote = writeLearnedDeviceId(this.api.user.configPath(), learned);
      if (wrote) {
        const live = readTSmartPlatformConfig(this.api.user.configPath());
        this.config.devices = live.devices;
        this.log.info(
          'Saved learned device id %s for %s into config',
          learned.deviceId,
          learned.name,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('Could not persist learned device id: %s', message);
    }
  }

  async reconcile(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    if (this.reconcileInFlight) {
      this.reconcilePending = true;
      return;
    }

    this.reconcileInFlight = true;
    try {
      do {
        this.reconcilePending = false;
        await this.reconcileUnlocked();
      } while (this.reconcilePending && !this.shuttingDown);
    } finally {
      this.reconcileInFlight = false;
    }
  }

  private startConfigWatch(): void {
    const configPath = this.api.user.configPath();
    try {
      this.configWatcher = watch(configPath, () => {
        if (this.shuttingDown || Date.now() < this.ignoreConfigWatchUntil) {
          return;
        }
        if (this.configWatchDebounce) {
          clearTimeout(this.configWatchDebounce);
        }
        this.configWatchDebounce = setTimeout(() => {
          this.configWatchDebounce = undefined;
          this.onConfigFileChanged();
        }, CONFIG_WATCH_DEBOUNCE_MS);
      });
      this.configWatcher.on('error', (error) => {
        this.log.warn('config.json watch error: %s', error.message);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('Could not watch config.json for live settings: %s', message);
    }
  }

  private stopConfigWatch(): void {
    if (this.configWatchDebounce) {
      clearTimeout(this.configWatchDebounce);
      this.configWatchDebounce = undefined;
    }
    if (this.configWatcher) {
      this.configWatcher.close();
      this.configWatcher = undefined;
    }
  }

  private suppressConfigWatch(ms = 2000): void {
    this.ignoreConfigWatchUntil = Date.now() + ms;
  }

  private onConfigFileChanged(): void {
    if (this.shuttingDown) {
      return;
    }

    try {
      const live = readTSmartPlatformConfig(this.api.user.configPath());
      this.config.devices = live.devices;
      this.log.info('Settings saved — applying device enable changes');
      void this.reconcile();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('Could not reload settings from config.json: %s', message);
    }
  }

  private async reconcileUnlocked(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    const configPath = this.api.user.configPath();
    this.suppressConfigWatch(3_000);

    for (const accessory of this.accessories.values()) {
      const cached = parseDeviceConfig(accessory.context.device);
      if (!cached) {
        continue;
      }
      try {
        const result = ensureCachedDeviceInConfig(configPath, cached);
        if (result.wrote) {
          this.config.devices = result.devices;
          this.log.info(
            'Added cached heater "%s" to config (enabled) — manage it under Devices',
            cached.name,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('Could not migrate cached device into config: %s', message);
      }
    }

    const desired = new Map<string, TSmartDeviceConfig>();

    const remember = (device: TSmartDeviceConfig) => {
      if (!isDeviceEnabled(device)) {
        return;
      }
      // deviceId is stable identity; IP-only rows also include name so two
      // different heaters at the same IP are not collapsed.
      const key = device.deviceId
        ? `id:${device.deviceId.toUpperCase()}`
        : `ip:${device.ip}:${normalizeDeviceName(device.name)}`;
      const prev = desired.get(key);
      if (prev) {
        this.log.warn(
          'Duplicate enabled device config for %s — keeping one entry',
          key,
        );
      }
      desired.set(
        key,
        prev
          ? { ...prev, ...device, deviceId: device.deviceId ?? prev.deviceId }
          : device,
      );
    };

    for (const raw of this.config.devices ?? []) {
      const device = parseDeviceConfig(raw);
      if (!device) {
        this.log.warn('Skipping invalid device config:', raw);
        continue;
      }
      if (!device.ip) {
        this.log.warn('Skipping device "%s" — IP required', device.name);
        continue;
      }
      remember(device);
    }

    if (this.shuttingDown) {
      return;
    }

    if (desired.size === 0) {
      this.log.warn(
        'No enabled T-Smart devices. Open plugin Settings, enable heaters, then Save.',
      );
    }

    const active = new Set<string>();
    const claimedUuids = new Set<string>();
    const disabledUuids = this.collectDisabledAccessoryUuids();

    for (const device of desired.values()) {
      if (this.shuttingDown) {
        return;
      }

      const { uuid, accessory: existingAccessory } = this.findExisting(device, claimedUuids);
      claimedUuids.add(uuid);
      active.add(uuid);

      let handler = this.handlers.get(uuid);

      if (!handler) {
        if (existingAccessory) {
          this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
          existingAccessory.context.device = device;
          existingAccessory.displayName = device.name;
          this.api.updatePlatformAccessories([existingAccessory]);
          handler = new TSmartPlatformAccessory(this, existingAccessory);
          this.handlers.set(uuid, handler);
        } else {
          this.log.info(
            'Adding new accessory: %s (%s%s)',
            device.name,
            device.ip,
            device.deviceId ? `, id ${device.deviceId}` : '',
          );
          const accessory = new this.api.platformAccessory(device.name, uuid);
          accessory.context.device = device;
          this.accessories.set(uuid, accessory);
          handler = new TSmartPlatformAccessory(this, accessory);
          this.handlers.set(uuid, handler);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }

      handler.updateEndpoint(device);
    }

    for (const [uuid, handler] of [...this.handlers.entries()]) {
      if (active.has(uuid)) {
        continue;
      }
      const accessory = this.accessories.get(uuid);
      const cached = parseDeviceConfig(accessory?.context.device);
      const isDisabled = disabledUuids.has(uuid);
      const stillConfigured = [...desired.values()].some((device) =>
        this.accessoryMatchesDevice(uuid, cached, device),
      );

      if (!isDisabled && stillConfigured) {
        continue;
      }

      this.log.info('Removing accessory: %s', accessory?.displayName ?? uuid);
      handler.destroy();
      this.handlers.delete(uuid);
      if (accessory) {
        this.accessories.delete(uuid);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  private collectDisabledAccessoryUuids(): Set<string> {
    const disabled = new Set<string>();
    for (const raw of this.config.devices ?? []) {
      const device = parseDeviceConfig(raw);
      if (!device || isDeviceEnabled(device)) {
        continue;
      }
      const { uuid } = this.findExisting(device, new Set());
      disabled.add(uuid);
      for (const [uuidKey, accessory] of this.accessories) {
        const cached = parseDeviceConfig(accessory.context.device);
        if (this.accessoryMatchesDevice(uuidKey, cached, device)) {
          disabled.add(uuidKey);
        }
      }
    }
    return disabled;
  }

  private accessoryMatchesDevice(
    uuid: string,
    cached: TSmartDeviceConfig | null,
    device: TSmartDeviceConfig,
  ): boolean {
    if (device.deviceId && deviceIdsMatch(cached?.deviceId, device.deviceId)) {
      return true;
    }
    if (cached?.ip === device.ip && deviceNamesMatch(cached.name, device.name)) {
      return true;
    }
    return uuid === this.uuidFor(device);
  }

  private uuidFor(device: Pick<TSmartDeviceConfig, 'deviceId' | 'ip'>): string {
    return device.deviceId
      ? this.api.hap.uuid.generate(`tsmart:id:${device.deviceId.toUpperCase()}`)
      : this.api.hap.uuid.generate(`tsmart:ip:${device.ip}`);
  }

  private findExisting(
    device: TSmartDeviceConfig,
    claimedUuids: ReadonlySet<string>,
  ): {
    uuid: string;
    accessory?: PlatformAccessory;
  } {
    const available = (uuid: string): boolean => !claimedUuids.has(uuid);

    if (device.deviceId) {
      const idUuid = this.uuidFor(device);
      const byIdUuid = this.accessories.get(idUuid);
      if (byIdUuid && available(idUuid)) {
        return { uuid: idUuid, accessory: byIdUuid };
      }

      for (const [uuid, accessory] of this.accessories) {
        if (!available(uuid)) {
          continue;
        }
        const cached = parseDeviceConfig(accessory.context.device);
        if (deviceIdsMatch(cached?.deviceId, device.deviceId)) {
          return { uuid, accessory };
        }
      }
    }

    const compatibleIdentity = (cached: TSmartDeviceConfig | null): boolean => {
      if (!device.deviceId) {
        return true;
      }
      if (!cached) {
        return false;
      }
      if (cached.deviceId) {
        return deviceIdsMatch(cached.deviceId, device.deviceId);
      }
      return deviceNamesMatch(cached.name, device.name);
    };

    const matchByIp = (ip: string): { uuid: string; accessory: PlatformAccessory } | undefined => {
      for (const seed of [`tsmart:ip:${ip}`, `tsmart:${ip}`]) {
        const seededUuid = this.api.hap.uuid.generate(seed);
        const seeded = this.accessories.get(seededUuid);
        if (seeded && available(seededUuid) && compatibleIdentity(parseDeviceConfig(seeded.context.device))) {
          return { uuid: seededUuid, accessory: seeded };
        }
      }

      for (const [uuid, accessory] of this.accessories) {
        if (!available(uuid)) {
          continue;
        }
        const cached = parseDeviceConfig(accessory.context.device);
        if (cached?.ip === ip && compatibleIdentity(cached)) {
          return { uuid, accessory };
        }
      }
      return undefined;
    };

    const byCurrentIp = matchByIp(device.ip);
    if (byCurrentIp) {
      return byCurrentIp;
    }

    let uuid = this.uuidFor(device);
    if (!available(uuid)) {
      uuid = this.api.hap.uuid.generate(
        `tsmart:ip:${device.ip}:${device.name}:${device.deviceId ?? ''}`,
      );
    }
    return { uuid };
  }
}
