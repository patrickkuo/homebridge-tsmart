export type TemperatureMode = 'high' | 'low' | 'average';

export type ModeToggleId = 'boost' | 'away' | 'eco' | 'smart';

export interface TSmartDeviceConfig {
  name: string;
  ip: string;
  /** Stable heater id from discovery / config read — survives IP changes. */
  deviceId?: string;
  temperatureMode?: TemperatureMode;
  modes?: ModeToggleId[];
}

const TEMPERATURE_MODES = new Set<TemperatureMode>(['high', 'low', 'average']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate device config from Homebridge config or accessory.context.
 * Returns null when required fields are missing/invalid.
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

  if (raw.temperatureMode !== undefined) {
    if (typeof raw.temperatureMode !== 'string' || !TEMPERATURE_MODES.has(raw.temperatureMode as TemperatureMode)) {
      return null;
    }
    device.temperatureMode = raw.temperatureMode as TemperatureMode;
  }

  if (raw.modes !== undefined) {
    if (!Array.isArray(raw.modes) || !raw.modes.every((mode) => typeof mode === 'string')) {
      return null;
    }
    // Unknown ids are filtered/warned later in the accessory.
    device.modes = raw.modes as ModeToggleId[];
  }

  return device;
}
