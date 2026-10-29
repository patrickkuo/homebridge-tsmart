import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { deviceIdsMatch, deviceNamesMatch } from './deviceMatch.js';
import { TSmartPlatformAccessory } from './platformAccessory.js';
import {
  DEFAULT_MODES,
  PLATFORM_NAME,
  PLUGIN_NAME,
  REDISCOVER_DEBOUNCE_MS,
  REDISCOVER_INTERVAL_MS,
} from './settings.js';
import { discoverDevices, type DiscoveredDevice } from './tsmart.js';
import {
  parseDeviceConfig,
  type ModeToggleId,
  type TemperatureMode,
  type TSmartDeviceConfig,
} from './types.js';

export type { ModeToggleId, TemperatureMode, TSmartDeviceConfig } from './types.js';

export interface TSmartPlatformConfig extends PlatformConfig {
  name?: string;
  /** UDP broadcast discovery / rediscovery (default true). */
  discovery?: boolean;
  /** Defaults applied to auto-discovered devices (and omitted device fields). */
  temperatureMode?: TemperatureMode;
  modes?: ModeToggleId[];
  devices?: TSmartDeviceConfig[];
}

/**
 * Homebridge dynamic platform for T-Smart / EUROICC water heaters.
 *
 * Accessories are matched by stable `deviceId` when known so an IP change
 * rebinds the same HomeKit accessory. Periodic rediscovery (and failure-driven
 * rediscovery) refreshes endpoints after network loss.
 */
export class TSmartPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories = new Map<string, PlatformAccessory>();
  private readonly handlers = new Map<string, TSmartPlatformAccessory>();

  private rediscoverTimer?: ReturnType<typeof setInterval>;
  private rediscoverDebounce?: ReturnType<typeof setTimeout>;
  private reconcileInFlight = false;
  private reconcilePending: { addNew: boolean } | null = null;
  private shuttingDown = false;

  /**
   * For the current reconcile pass: newIp → previousIp, so findExisting can
   * locate the HomeKit accessory still keyed/cached under the old IP.
   */
  private readonly ipAliases = new Map<string, string>();

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
      void this.reconcile({ addNew: this.discoveryEnabled });
      this.rediscoverTimer = setInterval(() => {
        void this.reconcile({ addNew: this.discoveryEnabled });
      }, REDISCOVER_INTERVAL_MS);
    });

    this.api.on('shutdown', () => {
      this.shuttingDown = true;
      if (this.rediscoverTimer) {
        clearInterval(this.rediscoverTimer);
        this.rediscoverTimer = undefined;
      }
      if (this.rediscoverDebounce) {
        clearTimeout(this.rediscoverDebounce);
        this.rediscoverDebounce = undefined;
      }
      for (const handler of this.handlers.values()) {
        handler.destroy();
      }
      this.handlers.clear();
    });
  }

  get discoveryEnabled(): boolean {
    return this.config.discovery !== false;
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Ask the platform to rebroadcast discovery soon (e.g. after poll failures).
   * Does not add brand-new heaters — only rebinds known deviceIds / configured IPs.
   */
  requestRediscovery(): void {
    if (this.rediscoverDebounce) {
      clearTimeout(this.rediscoverDebounce);
    }
    this.rediscoverDebounce = setTimeout(() => {
      this.rediscoverDebounce = undefined;
      void this.reconcile({ addNew: false });
    }, REDISCOVER_DEBOUNCE_MS);
  }

  async reconcile(options: { addNew: boolean }): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    if (this.reconcileInFlight) {
      this.reconcilePending = {
        addNew: Boolean(this.reconcilePending?.addNew || options.addNew),
      };
      return;
    }

    this.reconcileInFlight = true;
    try {
      let next: { addNew: boolean } | null = options;
      while (next && !this.shuttingDown) {
        const current = next;
        this.reconcilePending = null;
        await this.reconcileUnlocked(current);
        next = this.reconcilePending;
      }
    } finally {
      this.reconcileInFlight = false;
    }
  }

  private async reconcileUnlocked(options: { addNew: boolean }): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    const platformTempMode = this.config.temperatureMode ?? 'high';
    const platformModes = this.config.modes ?? DEFAULT_MODES;
    this.ipAliases.clear();

    /** Desired devices keyed by a stable lookup key (deviceId or ip:…). */
    const desired = new Map<string, TSmartDeviceConfig>();

    const remember = (device: TSmartDeviceConfig) => {
      const key = device.deviceId ? `id:${device.deviceId}` : `ip:${device.ip}`;
      const prev = desired.get(key);
      desired.set(
        key,
        prev
          ? { ...prev, ...device, deviceId: device.deviceId ?? prev.deviceId }
          : device,
      );
    };

    const forgetIpKey = (ip: string) => {
      desired.delete(`ip:${ip}`);
    };

    const recordIpMove = (previousIp: string, nextIp: string) => {
      if (previousIp !== nextIp) {
        this.ipAliases.set(nextIp, previousIp);
      }
    };

    for (const raw of this.config.devices ?? []) {
      const device = parseDeviceConfig(raw);
      if (!device) {
        this.log.warn('Skipping invalid device config:', raw);
        continue;
      }
      remember({
        ...device,
        temperatureMode: device.temperatureMode ?? platformTempMode,
        modes: device.modes ?? platformModes,
      });
    }

    // With discovery on, keep previously learned identities so offline heaters stay.
    // With discovery off, config.devices alone defines the set (cache must not resurrect removals).
    if (this.discoveryEnabled) {
      for (const accessory of this.accessories.values()) {
        const cached = parseDeviceConfig(accessory.context.device);
        if (!cached) {
          continue;
        }
        remember({
          ...cached,
          temperatureMode: cached.temperatureMode ?? platformTempMode,
          modes: cached.modes ?? platformModes,
        });
      }
    }

    let found: DiscoveredDevice[] = [];
    try {
      found = await discoverDevices(this.log);
      if (this.shuttingDown) {
        return;
      }
      this.log.info('Discovery found %d device(s)', found.length);
    } catch (error) {
      if (this.shuttingDown) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('UDP discovery failed: %s', message);
    }

    const foundIps = new Set(found.map((hit) => hit.ipAddress));
    const unmatched: DiscoveredDevice[] = [];

    for (const hit of found) {
      const byId = hit.deviceId ? desired.get(`id:${hit.deviceId}`) : undefined;
      let byIp = desired.get(`ip:${hit.ipAddress}`);

      // Don't assume IP-only config at this address is the same heater (DHCP reuse).
      if (byIp && !byId && !this.sameHeater(byIp, hit.deviceId, hit.name)) {
        byIp = undefined;
      }

      const existing = byId ?? byIp;

      if (!existing) {
        unmatched.push(hit);
        continue;
      }

      const previousIp = existing.ip;
      remember({
        ...existing,
        ip: hit.ipAddress,
        deviceId: hit.deviceId,
        name: existing.name || hit.name,
      });
      recordIpMove(previousIp, hit.ipAddress);

      if (hit.deviceId) {
        forgetIpKey(hit.ipAddress);
        if (previousIp !== hit.ipAddress) {
          forgetIpKey(previousIp);
        }
      }
    }

    // IP-only heaters missing from this broadcast (plus any cache-only leftovers).
    const listStaleIpOnly = (excludeIps: ReadonlySet<string>): TSmartDeviceConfig[] => {
      const stale: TSmartDeviceConfig[] = [];
      const seenIps = new Set<string>();

      for (const [key, device] of desired) {
        if (!key.startsWith('ip:') || device.deviceId || foundIps.has(device.ip) || excludeIps.has(device.ip)) {
          continue;
        }
        stale.push(device);
        seenIps.add(device.ip);
      }

      for (const accessory of this.accessories.values()) {
        const cached = parseDeviceConfig(accessory.context.device);
        if (
          !cached ||
          cached.deviceId ||
          foundIps.has(cached.ip) ||
          excludeIps.has(cached.ip) ||
          seenIps.has(cached.ip)
        ) {
          continue;
        }
        stale.push(cached);
        seenIps.add(cached.ip);
      }

      return stale;
    };

    const rebindIpOnly = (stale: TSmartDeviceConfig, hit: DiscoveredDevice) => {
      this.log.info(
        'Rebinding IP-only heater "%s" %s → %s (id %s)',
        stale.name,
        stale.ip,
        hit.ipAddress,
        hit.deviceId,
      );
      recordIpMove(stale.ip, hit.ipAddress);
      forgetIpKey(stale.ip);
      remember({
        ...stale,
        ip: hit.ipAddress,
        deviceId: hit.deviceId,
        name: stale.name || hit.name,
        temperatureMode: stale.temperatureMode ?? platformTempMode,
        modes: stale.modes ?? platformModes,
      });
    };

    // IP-only rebind before deviceId was learned — require a unique name match.
    if (unmatched.length > 0) {
      const rebound = new Set<string>();
      const stillUnmatched: DiscoveredDevice[] = [];

      for (const hit of unmatched) {
        const candidates = listStaleIpOnly(rebound).filter((stale) =>
          deviceNamesMatch(stale.name, hit.name),
        );

        if (candidates.length === 1) {
          const stale = candidates[0]!;
          rebindIpOnly(stale, hit);
          rebound.add(stale.ip);
          continue;
        }

        stillUnmatched.push(hit);
      }

      if (!options.addNew) {
        if (stillUnmatched.length > 0) {
          this.log.debug(
            'Ignoring %d unmatched discovery hit(s) during rediscovery (addNew=false)',
            stillUnmatched.length,
          );
        }
      } else {
        // stillUnmatched already failed name match against every missing IP-only heater,
        // so these hits are safe to treat as distinct devices.
        for (const hit of stillUnmatched) {
          remember({
            name: hit.name,
            ip: hit.ipAddress,
            deviceId: hit.deviceId,
            temperatureMode: platformTempMode,
            modes: platformModes,
          });
        }
      }
    }

    // Drop stale ip: keys after moves / deviceId promotion.
    for (const previousIp of this.ipAliases.values()) {
      forgetIpKey(previousIp);
    }
    for (const device of [...desired.values()]) {
      if (device.deviceId) {
        forgetIpKey(device.ip);
      }
    }

    if (this.shuttingDown) {
      return;
    }

    if (desired.size === 0) {
      this.log.warn(
        'No T-Smart devices found. Enable discovery (default) or add devices[].ip in config.',
      );
    }

    const active = new Set<string>();
    const claimedUuids = new Set<string>();
    const liveByIp = new Map(found.map((hit) => [hit.ipAddress, hit]));

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
          if (this.shuttingDown) {
            return;
          }
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

      const liveAtIp = liveByIp.get(device.ip);
      if (liveAtIp && !this.sameHeater(device, liveAtIp.deviceId, liveAtIp.name)) {
        this.log.warn(
          'Parking "%s"%s — IP %s currently serves "%s" (id %s)',
          device.name,
          device.deviceId ? ` (id ${device.deviceId})` : '',
          device.ip,
          liveAtIp.name,
          liveAtIp.deviceId,
        );
        handler.parkForIpConflict();
        continue;
      }

      handler.updateEndpoint(device);
    }

    // Prune inactive accessories: always when discovery is off; when discovery is on,
    // only remove orphans left behind after an IP rebind created a replacement UUID.
    const previousIps = new Set(this.ipAliases.values());
    for (const [uuid, handler] of [...this.handlers.entries()]) {
      if (active.has(uuid)) {
        continue;
      }
      const accessory = this.accessories.get(uuid);
      const cached = parseDeviceConfig(accessory?.context.device);
      const isStaleIpOrphan = cached !== null && previousIps.has(cached.ip);

      if (!isStaleIpOrphan && this.discoveryEnabled) {
        continue;
      }

      this.log.info(
        'Removing accessory after rebind/prune: %s',
        accessory?.displayName ?? uuid,
      );
      handler.destroy();
      this.handlers.delete(uuid);
      if (accessory) {
        this.accessories.delete(uuid);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  /** Known heater vs a live discovery/identity probe at an IP. */
  private sameHeater(
    known: Pick<TSmartDeviceConfig, 'deviceId' | 'name'>,
    liveDeviceId: string,
    liveName: string,
  ): boolean {
    if (known.deviceId) {
      return deviceIdsMatch(known.deviceId, liveDeviceId);
    }
    return deviceNamesMatch(known.name, liveName);
  }

  private uuidFor(device: Pick<TSmartDeviceConfig, 'deviceId' | 'ip'>): string {
    return device.deviceId
      ? this.api.hap.uuid.generate(`tsmart:id:${device.deviceId.toUpperCase()}`)
      : this.api.hap.uuid.generate(`tsmart:ip:${device.ip}`);
  }

  /**
   * Prefer stable deviceId UUID; fall back to IP (incl. legacy `tsmart:${ip}`).
   * Also matches accessories still cached under a previous IP from this reconcile.
   */
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
      // Cached IP-only accessory: only reuse when promoting the same heater (name match).
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

    const previousIp = this.ipAliases.get(device.ip);
    if (previousIp) {
      const byPrevious = matchByIp(previousIp);
      if (byPrevious) {
        return byPrevious;
      }
    }

    let uuid = this.uuidFor(device);
    // Two desired entries must never share one HomeKit UUID in the same pass
    // (e.g. parked IP-only heater + live peer at the same address).
    if (!available(uuid)) {
      uuid = this.api.hap.uuid.generate(
        `tsmart:ip:${device.ip}:${device.name}:${device.deviceId ?? ''}`,
      );
    }
    return { uuid };
  }
}
