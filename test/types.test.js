import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseDeviceConfig } from '../dist/types.js';

describe('parseDeviceConfig', () => {
  it('accepts a minimal valid device', () => {
    assert.deepEqual(parseDeviceConfig({ name: 'HW', ip: '192.168.1.2' }), {
      name: 'HW',
      ip: '192.168.1.2',
    });
  });

  it('rejects missing name or ip', () => {
    assert.equal(parseDeviceConfig({ name: 'HW' }), null);
    assert.equal(parseDeviceConfig({ ip: '1.2.3.4' }), null);
  });

  it('rejects invalid temperatureMode', () => {
    assert.equal(
      parseDeviceConfig({ name: 'HW', ip: '1.2.3.4', temperatureMode: 'hot' }),
      null,
    );
  });
});
