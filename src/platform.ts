import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { TSmartPlatformAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { parseDeviceConfig, type TSmartDeviceConfig } from './types.js';

export type { ModeToggleId, TemperatureMode, TSmartDeviceConfig } from './types.js';

export interface TSmartPlatformConfig extends PlatformConfig {
  name?: string;
  devices?: TSmartDeviceConfig[];
}

/**
 * Homebridge dynamic platform for T-Smart / EUROICC water heaters.
 */
export class TSmartPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories = new Map<string, PlatformAccessory>();
  private readonly handlers = new Map<string, TSmartPlatformAccessory>();

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
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
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

  discoverDevices(): void {
    const devices = this.config.devices ?? [];
    const discovered = new Set<string>();
    const seenIps = new Set<string>();

    if (devices.length === 0) {
      this.log.warn('No devices configured. Add devices under the TSmart platform config.');
    }

    for (const raw of devices) {
      const device = parseDeviceConfig(raw);
      if (!device) {
        this.log.warn('Skipping invalid device config:', raw);
        continue;
      }

      if (seenIps.has(device.ip)) {
        this.log.warn('Duplicate device IP %s — skipping "%s"', device.ip, device.name);
        continue;
      }
      seenIps.add(device.ip);

      const uuid = this.api.hap.uuid.generate(`tsmart:${device.ip}`);
      discovered.add(uuid);

      this.handlers.get(uuid)?.destroy();

      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        existingAccessory.context.device = device;
        existingAccessory.displayName = device.name;
        this.api.updatePlatformAccessories([existingAccessory]);
        this.handlers.set(uuid, new TSmartPlatformAccessory(this, existingAccessory));
      } else {
        this.log.info('Adding new accessory:', device.name);
        const accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.device = device;
        this.accessories.set(uuid, accessory);
        this.handlers.set(uuid, new TSmartPlatformAccessory(this, accessory));
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    for (const [uuid, accessory] of this.accessories) {
      if (!discovered.has(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.handlers.get(uuid)?.destroy();
        this.handlers.delete(uuid);
        this.accessories.delete(uuid);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
