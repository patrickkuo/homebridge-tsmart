import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  mergeDiscoveredIntoDevices,
  persistLearnedDeviceId,
  upsertDiscoveredDevices,
} from '../dist/configStore.js';

function writeConfig(path, platform) {
  writeFileSync(
    path,
    JSON.stringify({ bridge: { name: 'Homebridge' }, platforms: [platform] }, null, 2),
  );
}

describe('configStore', () => {
  it('merges by deviceId and updates IP without duplicating', () => {
    const merged = mergeDiscoveredIntoDevices(
      [
        {
          enabled: true,
          name: 'Existing',
          ip: '192.168.1.10',
          deviceId: 'AAAA',
        },
      ],
      [
        { name: 'Existing', ip: '192.168.1.99', deviceId: 'AAAA' },
        { name: 'New Heater', ip: '192.168.1.20', deviceId: 'BBBB' },
      ],
      { addNew: true },
    );

    assert.equal(merged.devices.length, 2);
    assert.equal(merged.added, 1);
    assert.equal(merged.updated, 1);
    assert.equal(merged.ipChanged, 1);
    assert.equal(merged.devices.find((d) => d.deviceId === 'AAAA').ip, '192.168.1.99');
    assert.equal(merged.devices.find((d) => d.deviceId === 'BBBB').enabled, false);
  });

  it('promotes an IP-only manual row instead of duplicating on scan', () => {
    const merged = mergeDiscoveredIntoDevices(
      [{ enabled: true, name: 'Water Heater', ip: '192.168.1.50' }],
      [{ name: 'Water Heater', ip: '192.168.1.50', deviceId: 'ABCD' }],
      { addNew: true },
    );

    assert.equal(merged.devices.length, 1);
    assert.equal(merged.added, 0);
    assert.equal(merged.promoted, 1);
    assert.equal(merged.devices[0].deviceId, 'ABCD');
    assert.equal(merged.devices[0].enabled, true);
  });

  it('keeps enabled:false when deduping against a row that omits enabled', () => {
    const merged = mergeDiscoveredIntoDevices(
      [
        { enabled: false, name: 'A', ip: '192.168.1.10', deviceId: 'AAAA' },
        { name: 'A', ip: '192.168.1.10', deviceId: 'AAAA' },
      ],
      [],
      { addNew: true },
    );
    assert.equal(merged.devices.length, 1);
    assert.equal(merged.devices[0].enabled, false);
  });

  it('does not collapse two different deviceIds that share an IP', () => {
    const merged = mergeDiscoveredIntoDevices(
      [{ enabled: true, name: 'A', ip: '192.168.1.50', deviceId: 'AAAA' }],
      [{ name: 'B', ip: '192.168.1.50', deviceId: 'BBBB' }],
      { addNew: true },
    );

    assert.equal(merged.devices.length, 2);
    assert.equal(merged.added, 1);
  });

  it('persists a learned deviceId onto an IP-only config row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsmart-config-'));
    const path = join(dir, 'config.json');
    writeConfig(path, {
      platform: 'TSmart',
      name: 'T-Smart',
      devices: [{ enabled: true, name: 'HW', ip: '192.168.1.50' }],
    });

    assert.equal(
      persistLearnedDeviceId(path, {
        name: 'HW',
        ip: '192.168.1.50',
        deviceId: 'abcd',
      }),
      true,
    );

    const again = upsertDiscoveredDevices(
      path,
      [{ name: 'HW', ip: '192.168.1.50', deviceId: 'ABCD' }],
      { addNew: true },
    );
    assert.equal(again.devices.length, 1);
    assert.equal(again.devices[0].deviceId, 'ABCD');
    assert.equal(again.added.length, 0);
  });
});
