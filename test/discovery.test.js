import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __test__ } from '../dist/tsmart.js';

describe('discovery response parsing', () => {
  it('parses a valid discovery reply', () => {
    const request = Buffer.from([0x01, 0, 0, 0x54]);
    const data = Buffer.alloc(43);
    data[0] = 0x01;
    data.writeUInt16LE(1, 3); // device_type
    data.writeUInt32LE(0xabcd, 5);
    Buffer.from('Hot Water\0').copy(data, 9);
    // checksum over all but last
    let checksum = 0;
    for (let i = 0; i < data.length - 1; i++) {
      checksum ^= data[i];
    }
    data[data.length - 1] = checksum ^ 0x55;

    const parsed = __test__.parseDiscoveryResponse(data, request);
    assert.deepEqual(parsed, { deviceId: 'ABCD', name: 'Hot Water' });
  });

  it('ignores broadcast echo', () => {
    const request = Buffer.from([0x01, 0, 0, 0x54]);
    assert.equal(__test__.parseDiscoveryResponse(request, request), null);
  });
});
