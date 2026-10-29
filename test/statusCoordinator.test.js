import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StatusCoordinator } from '../dist/statusCoordinator.js';

describe('StatusCoordinator', () => {
  it('drops poll results that started before a control', () => {
    const sync = new StatusCoordinator();
    const genAtStart = sync.generation;
    const controlGen = sync.beginControl();

    assert.equal(sync.shouldApplyPollResult(genAtStart), false);
    assert.equal(sync.shouldApplyControlRefresh(controlGen), true);

    sync.endControl(controlGen);
    assert.equal(sync.controlInFlight, false);
  });

  it('invalidates older control refresh after a newer control', () => {
    const sync = new StatusCoordinator();
    const first = sync.beginControl();
    const second = sync.beginControl();

    assert.equal(sync.shouldApplyControlRefresh(first), false);
    assert.equal(sync.shouldApplyControlRefresh(second), true);

    sync.endControl(first);
    assert.equal(sync.controlInFlight, true);
    sync.endControl(second);
    assert.equal(sync.controlInFlight, false);
  });

  it('invalidate bumps generation and clears in-flight', () => {
    const sync = new StatusCoordinator();
    const gen = sync.beginControl();
    sync.invalidate();

    assert.equal(sync.shouldApplyControlRefresh(gen), false);
    assert.equal(sync.controlInFlight, false);
  });
});
