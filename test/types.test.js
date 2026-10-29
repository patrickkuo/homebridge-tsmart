import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isDeviceEnabled, parseDeviceConfig } from '../dist/types.js';

describe('parseDeviceConfig', () => {
  it('accepts a minimal valid device', () => {
    assert.deepEqual(parseDeviceConfig({ name: 'HW', ip: '192.168.1.2' }), {
      name: 'HW',
      ip: '192.168.1.2',
    });
  });

  it('parses enabled flag', () => {
    assert.deepEqual(
      parseDeviceConfig({ name: 'HW', ip: '192.168.1.2', enabled: false }),
      { name: 'HW', ip: '192.168.1.2', enabled: false },
    );
  });

  it('rejects missing name or ip', () => {
    assert.equal(parseDeviceConfig({ name: 'HW' }), null);
    assert.equal(parseDeviceConfig({ ip: '1.2.3.4' }), null);
  });

  it('ignores legacy temperatureMode keys', () => {
    assert.deepEqual(
      parseDeviceConfig({ name: 'HW', ip: '1.2.3.4', temperatureMode: 'hot' }),
      { name: 'HW', ip: '1.2.3.4' },
    );
  });

  it('treats omitted enabled as on', () => {
    assert.equal(isDeviceEnabled({}), true);
    assert.equal(isDeviceEnabled({ enabled: true }), true);
    assert.equal(isDeviceEnabled({ enabled: false }), false);
  });
});

