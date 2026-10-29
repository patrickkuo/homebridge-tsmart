import { readFileSync, writeFileSync } from 'node:fs';

import { deviceIdsMatch } from './deviceMatch.js';
import { PLATFORM_NAME } from './settings.js';
import { parseDeviceConfig, type TSmartDeviceConfig } from './types.js';

export interface DiscoveredUpsert {
  name: string;
  ip: string;
  deviceId?: string;
}

export interface MergeResult {
  devices: TSmartDeviceConfig[];
  added: number;
  updated: number;
  ipChanged: number;
  /** Rows that gained a deviceId (IP-only → stable id). */
  promoted: number;
}

export interface UpsertResult {
  devices: TSmartDeviceConfig[];
  wrote: boolean;
  added: TSmartDeviceConfig[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface LivePlatformConfig {
  devices: TSmartDeviceConfig[];
}

/** Read the live TSmart platform block from config.json (UI Save updates this file). */
export function readTSmartPlatformConfig(configPath: string): LivePlatformConfig {
  const { devices } = readPlatformDevices(configPath);
  return { devices };
}

function readPlatformDevices(configPath: string): {
  raw: Record<string, unknown>;
  platforms: unknown[];
  platformIndex: number;
  devices: TSmartDeviceConfig[];
} {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.platforms)) {
    throw new Error('config.json missing platforms array');
  }

  const platforms = parsed.platforms;
  const platformIndex = platforms.findIndex(
    (entry) => isRecord(entry) && entry.platform === PLATFORM_NAME,
  );
  if (platformIndex < 0) {
    throw new Error(`No ${PLATFORM_NAME} platform entry in config.json`);
  }

  const platform = platforms[platformIndex];
  const devicesRaw =
    isRecord(platform) && Array.isArray(platform.devices) ? platform.devices : [];
  const devices: TSmartDeviceConfig[] = [];
  for (const entry of devicesRaw) {
    const device = parseDeviceConfig(entry);
    if (device) {
      devices.push({ ...device });
    }
  }

  return { raw: parsed, platforms, platformIndex, devices };
}

function writePlatformDevices(
  configPath: string,
  raw: Record<string, unknown>,
  platforms: unknown[],
  platformIndex: number,
  devices: TSmartDeviceConfig[],
): void {
  const platform = {
    ...(platforms[platformIndex] as Record<string, unknown>),
    devices,
  };
  platforms[platformIndex] = platform;
  raw.platforms = platforms;
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

/**
 * Find an existing config row for a discovery hit.
 * 1) Same deviceId (stable identity; IP may have changed)
 * 2) Else IP-only row at the same IP (manual add / legacy) → promote with deviceId
 */
export function findDeviceIndex(
  devices: TSmartDeviceConfig[],
  hit: DiscoveredUpsert,
): number {
  if (hit.deviceId) {
    const byId = devices.findIndex((d) => deviceIdsMatch(d.deviceId, hit.deviceId));
    if (byId >= 0) {
      return byId;
    }
  }

  if (hit.ip && hit.deviceId) {
    return devices.findIndex((d) => d.ip === hit.ip && !d.deviceId);
  }

  return -1;
}

function dedupeByDeviceId(devices: TSmartDeviceConfig[]): TSmartDeviceConfig[] {
  const result: TSmartDeviceConfig[] = [];
  for (const device of devices) {
    if (!device.deviceId) {
      result.push({ ...device });
      continue;
    }
    const index = result.findIndex((d) => deviceIdsMatch(d.deviceId, device.deviceId));
    if (index < 0) {
      result.push({ ...device });
      continue;
    }
    const prev = result[index]!;
    result[index] = {
      ...prev,
      ...device,
      deviceId: device.deviceId.toUpperCase(),
      ip: device.ip || prev.ip,
      name: prev.name || device.name,
      // Prefer explicit true; otherwise keep an explicit false (don't drop to undefined).
      enabled:
        prev.enabled === true || device.enabled === true
          ? true
          : prev.enabled === false || device.enabled === false
            ? false
            : prev.enabled,
    };
  }
  return result;
}

/**
 * Pure merge used by the settings UI Scan path and config upserts.
 * - Known deviceId → refresh IP (never duplicate)
 * - IP-only row at same IP → attach deviceId (promote; keep enabled/name)
 * - Otherwise → append enabled:false when addNew
 */
export function mergeDiscoveredIntoDevices(
  existing: TSmartDeviceConfig[],
  hits: DiscoveredUpsert[],
  options: { addNew: boolean } = { addNew: true },
): MergeResult {
  const devices = dedupeByDeviceId(existing.map((d) => ({ ...d })));
  let added = 0;
  let updated = 0;
  let ipChanged = 0;
  let promoted = 0;

  for (const hit of hits) {
    if (!hit.deviceId) {
      continue;
    }
    const deviceId = hit.deviceId.toUpperCase();
    const index = findDeviceIndex(devices, { ...hit, deviceId });
    if (index >= 0) {
      const prev = devices[index]!;
      const wasIpOnly = !prev.deviceId;
      const next: TSmartDeviceConfig = {
        ...prev,
        deviceId,
        ip: hit.ip || prev.ip,
        name: prev.name || hit.name,
      };
      if (hit.ip && prev.ip && hit.ip !== prev.ip) {
        ipChanged += 1;
      }
      if (wasIpOnly) {
        promoted += 1;
      }
      devices[index] = next;
      updated += 1;
      continue;
    }

    if (!options.addNew) {
      continue;
    }

    devices.push({
      enabled: false,
      name: hit.name,
      ip: hit.ip,
      deviceId,
    });
    added += 1;
  }

  return { devices, added, updated, ipChanged, promoted };
}

/**
 * Merge discovery hits into config.json devices[].
 */
export function upsertDiscoveredDevices(
  configPath: string,
  hits: DiscoveredUpsert[],
  options: { addNew: boolean },
): UpsertResult {
  const { raw, platforms, platformIndex, devices } = readPlatformDevices(configPath);
  const before = JSON.stringify(devices);
  const merged = mergeDiscoveredIntoDevices(devices, hits, options);
  const wrote = JSON.stringify(merged.devices) !== before;

  if (wrote) {
    writePlatformDevices(configPath, raw, platforms, platformIndex, merged.devices);
  }

  const addedDevices = merged.devices.filter(
    (d) =>
      d.deviceId &&
      hits.some((h) => deviceIdsMatch(h.deviceId, d.deviceId)) &&
      !devices.some((prev) => deviceIdsMatch(prev.deviceId, d.deviceId)),
  );

  return { devices: merged.devices, wrote, added: addedDevices };
}

/**
 * Persist a deviceId learned at runtime (0x21) onto the matching config row.
 * Prefers deviceId match; otherwise promotes an IP-only row at this IP.
 */
export function persistLearnedDeviceId(
  configPath: string,
  learned: { name: string; ip: string; deviceId: string },
): boolean {
  const { raw, platforms, platformIndex, devices } = readPlatformDevices(configPath);
  const deviceId = learned.deviceId.toUpperCase();
  const index = findDeviceIndex(devices, {
    name: learned.name,
    ip: learned.ip,
    deviceId,
  });

  if (index >= 0) {
    const current = devices[index]!;
    if (deviceIdsMatch(current.deviceId, deviceId) && current.ip === learned.ip) {
      return false;
    }
    devices[index] = {
      ...current,
      deviceId,
      ip: learned.ip || current.ip,
    };
    writePlatformDevices(configPath, raw, platforms, platformIndex, devices);
    return true;
  }

  return false;
}

/**
 * Ensure a HomeKit-cached heater exists in config (upgrade from pre-devices[] installs).
 * New rows are written with `enabled: true` so existing tiles keep working.
 */
export function ensureCachedDeviceInConfig(
  configPath: string,
  cached: TSmartDeviceConfig,
): UpsertResult {
  const { raw, platforms, platformIndex, devices } = readPlatformDevices(configPath);
  if (!cached.deviceId) {
    return { devices, wrote: false, added: [] };
  }

  const index = findDeviceIndex(devices, {
    name: cached.name,
    ip: cached.ip,
    deviceId: cached.deviceId,
  });
  if (index >= 0) {
    const current = devices[index]!;
    if (cached.ip && current.ip !== cached.ip) {
      devices[index] = { ...current, ip: cached.ip, deviceId: cached.deviceId.toUpperCase() };
      writePlatformDevices(configPath, raw, platforms, platformIndex, devices);
      return { devices, wrote: true, added: [] };
    }
    if (!current.deviceId) {
      devices[index] = { ...current, deviceId: cached.deviceId.toUpperCase() };
      writePlatformDevices(configPath, raw, platforms, platformIndex, devices);
      return { devices, wrote: true, added: [] };
    }
    return { devices, wrote: false, added: [] };
  }

  const created: TSmartDeviceConfig = {
    enabled: true,
    name: cached.name,
    ip: cached.ip,
    deviceId: cached.deviceId,
  };
  devices.push(created);
  writePlatformDevices(configPath, raw, platforms, platformIndex, devices);
  return { devices, wrote: true, added: [created] };
}
