// The per-user queue (serialize) is not reentrant. These tests keep the contract in
// docs/bookmark-store-plan.md, section 3: a nested call with the same key fails, it does not wait.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize, sleep } from '../src/util.js';

describe('serialize', () => {
  test('runs the turns of one key one after another', async () => {
    const order = [];
    await Promise.all([
      serialize('a', async () => { order.push('1 start'); await sleep(20); order.push('1 end'); }),
      serialize('a', async () => { order.push('2 start'); order.push('2 end'); }),
    ]);
    assert.deepEqual(order, ['1 start', '1 end', '2 start', '2 end']);
  });

  test('a nested call with the same key fails at once and does not wait', async () => {
    const result = await Promise.race([
      serialize('a', async () => {
        await assert.rejects(serialize('a', async () => 'never'), /inside a turn of the same key/);
        return 'outer done';
      }),
      sleep(1000).then(() => 'deadlock'),
    ]);
    assert.equal(result, 'outer done');
  });

  test('a nested call fails after an await inside the turn', async () => {
    await serialize('a', async () => {
      await sleep(5);
      await assert.rejects(serialize('a', async () => {}), /same key/);
    });
  });

  test('a nested call with another key is allowed', async () => {
    const value = await serialize('a', () => serialize('b', async () => 'inner'));
    assert.equal(value, 'inner');
  });

  test('the same key works again after the turn ends', async () => {
    await serialize('a', async () => {});
    assert.equal(await serialize('a', async () => 'again'), 'again');
  });

  test('known limit: work that starts inside a turn keeps the key after the turn ends', async () => {
    // The guard follows the async context, not the state of the turn. Such work must start outside the turn.
    // This test documents the limit. If the guard changes to follow active turns, change this test.
    let later;
    await serialize('a', async () => {
      later = sleep(20).then(() => serialize('a', async () => 'ran'));
    });
    await assert.rejects(later, /same key/);
    assert.equal(await serialize('a', async () => 'outside'), 'outside');
  });

  test('a failed turn does not block the next turn, and its error reaches the caller', async () => {
    await assert.rejects(serialize('a', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await serialize('a', async () => 'next'), 'next');
  });

  test('two separate callers are not mistaken for a nested call', async () => {
    const results = await Promise.all([1, 2, 3].map((n) => serialize('a', async () => n)));
    assert.deepEqual(results, [1, 2, 3]);
  });
});
