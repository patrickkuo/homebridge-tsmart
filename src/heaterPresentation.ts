import type { TemperatureMode } from './types.js';
import type { TSmartStatus } from './tsmart.js';

export type HeaterCurrentState = 'inactive' | 'idle' | 'heating';

export interface HeaterPresentation {
  active: boolean;
  currentState: HeaterCurrentState;
  /** Heat-only accessory; always heat. */
  targetState: 'heat';
  currentTemperature: number;
  targetTemperature: number;
}

export function presentHeater(
  status: TSmartStatus,
  temperatureMode: TemperatureMode,
  clampSetpoint: (value: number) => number,
): HeaterPresentation {
  return {
    active: status.power,
    currentState: !status.power
      ? 'inactive'
      : status.relay
        ? 'heating'
        : 'idle',
    targetState: 'heat',
    currentTemperature: currentTemperature(status, temperatureMode),
    targetTemperature: clampSetpoint(status.setpoint),
  };
}

export function currentTemperature(
  status: TSmartStatus,
  temperatureMode: TemperatureMode,
): number {
  switch (temperatureMode) {
    case 'low':
      return status.temperatureLow;
    case 'average':
      return status.temperatureAverage;
    case 'high':
    default:
      return status.temperatureHigh;
  }
}

export function clampSetpoint(
  value: number,
  min: number,
  max: number,
  step: number,
): number {
  const stepped = Math.round(value / step) * step;
  const clamped = Math.min(max, Math.max(min, stepped));
  return Math.round(clamped * 10) / 10;
}
