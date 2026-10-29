import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deviceIdsMatch,
  deviceNamesMatch,
  modeListsEqual,
  normalizeDeviceName,
} from '../dist/deviceMatch.js';

describe('deviceMatch', () => {
  it('normalizes whitespace and case', () => {
    assert.equal(normalizeDeviceName('  Hot   Water '), 'hot water');
  });

  it('matches equal names', () => {
    assert.equal(deviceNamesMatch('Hot Water', 'hot water'), true);
  });

  it('rejects empty or mismatched names', () => {
    assert.equal(deviceNamesMatch('', 'Hot Water'), false);
    assert.equal(deviceNamesMatch('Upstairs', 'Downstairs'), false);
  });

  it('matches device ids case-insensitively', () => {
    assert.equal(deviceIdsMatch('abcd', 'ABCD'), true);
    assert.equal(deviceIdsMatch('abcd', 'abce'), false);
    assert.equal(deviceIdsMatch(undefined, 'abcd'), false);
  });

  it('compares mode lists by sequence', () => {
    assert.equal(modeListsEqual(['boost', 'away'], ['boost', 'away']), true);
    assert.equal(modeListsEqual(['boost'], ['away']), false);
    assert.equal(modeListsEqual(undefined, undefined), true);
    assert.equal(modeListsEqual(undefined, ['boost']), false);
  });
});
