export interface TSmartDeviceConfig {
  name: string;
  ip: string;
  /** Stable heater id from discovery / config read — survives IP changes. */
  deviceId?: string;
  /**
   * When false, listed in config but not exposed to HomeKit.
   * Omitted / undefined means enabled (backward compatible).
   */
  enabled?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** HomeKit exposure: omitted `enabled` counts as on. */
export function isDeviceEnabled(device: Pick<TSmartDeviceConfig, 'enabled'>): boolean {
  return device.enabled !== false;
}

/**
 * Validate device config from Homebridge config or accessory.context.
 * Returns null when required fields are missing/invalid.
 * Legacy `modes` / `temperatureMode` keys are ignored.
 */
export function parseDeviceConfig(raw: unknown): TSmartDeviceConfig | null {
  if (!isRecord(raw)) {
    return null;
  }

  const name = raw.name;
  const ip = raw.ip;
  if (typeof name !== 'string' || name.length === 0) {
    return null;
  }
  if (typeof ip !== 'string' || ip.length === 0) {
    return null;
  }

  const device: TSmartDeviceConfig = { name, ip };

  if (raw.deviceId !== undefined) {
    if (typeof raw.deviceId !== 'string' || raw.deviceId.length === 0) {
      return null;
    }
    device.deviceId = raw.deviceId.toUpperCase();
  }

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      return null;
    }
    device.enabled = raw.enabled;
  }

  return device;
}
