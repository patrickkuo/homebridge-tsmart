import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clampSetpoint, presentHeater } from '../dist/heaterPresentation.js';
import { TSmartMode } from '../dist/tsmart.js';

describe('heaterPresentation', () => {
  const status = {
    power: true,
    setpoint: 55.2,
    mode: TSmartMode.Manual,
    temperatureHigh: 60,
    temperatureLow: 40,
    temperatureAverage: 50,
    relay: true,
  };

  it('maps power+relay to heating', () => {
    const view = presentHeater(status, 'high', (v) => clampSetpoint(v, 15, 70, 0.5));
    assert.equal(view.active, true);
    assert.equal(view.currentState, 'heating');
    assert.equal(view.currentTemperature, 60);
    assert.equal(view.targetTemperature, 55);
  });

  it('maps power off to inactive', () => {
    const view = presentHeater(
      { ...status, power: false, relay: false },
      'average',
      (v) => clampSetpoint(v, 15, 70, 0.5),
    );
    assert.equal(view.active, false);
    assert.equal(view.currentState, 'inactive');
    assert.equal(view.currentTemperature, 50);
  });

  it('clamps setpoint to bounds and step', () => {
    assert.equal(clampSetpoint(12, 15, 70, 0.5), 15);
    assert.equal(clampSetpoint(80, 15, 70, 0.5), 70);
    assert.equal(clampSetpoint(55.24, 15, 70, 0.5), 55);
  });
});
