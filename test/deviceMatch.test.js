import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deviceIdsMatch,
  deviceNamesMatch,
  normalizeDeviceName,
} from '../dist/deviceMatch.js';

describe('deviceMatch', () => {
  it('normalizes whitespace and case', () => {
    assert.equal(normalizeDeviceName('  Hot  Water '), 'hot water');
  });

  it('matches equal names', () => {
    assert.equal(deviceNamesMatch('Hot Water', 'hot water'), true);
  });

  it('rejects empty or mismatched names', () => {
    assert.equal(deviceNamesMatch('', 'x'), false);
    assert.equal(deviceNamesMatch('a', 'b'), false);
  });

  it('matches device ids case-insensitively', () => {
    assert.equal(deviceIdsMatch('abcd', 'ABCD'), true);
    assert.equal(deviceIdsMatch(undefined, 'ABCD'), false);
  });
});
