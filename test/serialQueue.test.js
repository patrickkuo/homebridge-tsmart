import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SerialQueue } from '../dist/serialQueue.js';

describe('SerialQueue', () => {
  it('runs tasks in order', async () => {
    const queue = new SerialQueue();
    const order = [];

    const first = queue.enqueue(async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a-end');
      return 1;
    });
    const second = queue.enqueue(async () => {
      order.push('b');
      return 2;
    });

    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(order, ['a-start', 'a-end', 'b']);
  });

  it('isolates task failures from later tasks', async () => {
    const queue = new SerialQueue();

    await assert.rejects(
      queue.enqueue(async () => {
        throw new Error('boom');
      }),
      /boom/,
    );

    assert.equal(await queue.enqueue(async () => 'ok'), 'ok');
  });
});
