// Database behaviour that the unit tests cannot show. Needs the test database.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestSchema, dropTestSchema, SKIP_REASON, TEST_URL } from './helpers/db.js';

describe('store writes', { skip: SKIP_REASON }, () => {
  let store;
  let schema;

  before(async () => {
    schema = await createTestSchema();
    const { openStore } = await import('../src/store.js');
    store = openStore({ url: TEST_URL, schema });
  });

  after(async () => {
    await store.close();
    await dropTestSchema(schema);
  });

  test('two status replacements for one user at the same time both succeed', async () => {
    // Many bookmark IDs make the inserts slow enough to overlap.
    const ids = Array.from({ length: 2000 }, (_, i) => 100000 + i);
    for (let round = 0; round < 5; round++) {
      await Promise.all([
        store.replaceStatus('race@example.test', new Set(ids), new Set()),
        store.replaceStatus('race@example.test', new Set(ids), new Set()),
      ]);
    }
    assert.equal((await store.known('race@example.test')).size, ids.length);
    assert.equal(await store.hasBaseline('race@example.test'), true);
  });
});
