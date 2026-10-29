import type { TSmartStatus } from './tsmart.js';

export type HeaterCurrentState = 'inactive' | 'idle' | 'heating';

export interface HeaterPresentation {
  active: boolean;
  currentState: HeaterCurrentState;
  /** Heat-only accessory; always heat. */
  targetState: 'heat';
  /** Always the High probe (matches device display). */
  currentTemperature: number;
  targetTemperature: number;
}

export function presentHeater(
  status: TSmartStatus,
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
    currentTemperature: status.temperatureHigh,
    targetTemperature: clampSetpoint(status.setpoint),
  };
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
