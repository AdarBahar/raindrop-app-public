import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJson } from '../src/server.js';

// A request body that arrives in the given chunks.
async function* chunks(...parts) {
  yield* parts;
}

test('a character whose bytes are in two chunks stays whole', async () => {
  const note = 'הערה 🙂 with a line\nbreak';
  const bytes = Buffer.from(JSON.stringify({ note }));
  // Each split point, so the test cuts each multibyte character at each of its bytes.
  for (let cut = 1; cut < bytes.length; cut++) {
    const body = await readJson(chunks(bytes.subarray(0, cut), bytes.subarray(cut)));
    assert.equal(body.note, note, `split at byte ${cut}`);
  }
});

test('an empty body is an empty object, and bad JSON and a large body are refused', async () => {
  assert.deepEqual(await readJson(chunks()), {});
  await assert.rejects(readJson(chunks(Buffer.from('{"a":'))), { status: 400, message: 'The request body is not valid JSON.' });
  await assert.rejects(readJson(chunks(Buffer.from('x'.repeat(65537)))), { status: 413, message: 'The request is too large.' });
});
