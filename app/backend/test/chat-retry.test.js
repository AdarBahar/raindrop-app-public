import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { chat } from '../src/llm.js';

// chat() with a stubbed fetch. Retry rules: a connection failure and a 5xx error are retried,
// up to 4 tries in total. A timeout and a 4xx error are not retried.
async function withStub(replies, fn) {
  const saved = { ...config.llm };
  const realFetch = globalThis.fetch;
  config.llm.endpoint = 'http://llm.invalid';
  config.llm.token = 'dummy';
  config.llm.minIntervalMs = 0;
  config.llm.retryWaitMs = 0;
  let calls = 0;
  globalThis.fetch = async () => {
    const next = replies[Math.min(calls, replies.length - 1)];
    calls += 1;
    if (next instanceof Error) throw next;
    return {
      status: next.status ?? 200,
      ok: (next.status ?? 200) < 400,
      text: async () => {
        if (next.brokenBody) throw new TypeError('terminated');
        return next.text ?? JSON.stringify({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] });
      },
    };
  };
  try {
    return await fn(() => calls);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(config.llm, saved);
  }
}

const ok = { status: 200 };

test('chat retries a connection failure and then succeeds', async () => {
  await withStub([new TypeError('fetch failed'), ok], async (calls) => {
    assert.equal(await chat([{ role: 'user', content: 'x' }]), 'hello');
    assert.equal(calls(), 2);
  });
});

test('chat retries a 503 and then succeeds', async () => {
  await withStub([{ status: 503, text: 'busy' }, ok], async (calls) => {
    assert.equal(await chat([{ role: 'user', content: 'x' }]), 'hello');
    assert.equal(calls(), 2);
  });
});

test('chat gives up after 4 connection failures and names the error', async () => {
  await withStub([new TypeError('fetch failed')], async (calls) => {
    await assert.rejects(chat([{ role: 'user', content: 'x' }]), /fetch failed/);
    assert.equal(calls(), 4);
  });
});

test('chat does not retry a timeout', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  await withStub([timeout, ok], async (calls) => {
    await assert.rejects(chat([{ role: 'user', content: 'x' }]), /timeout/);
    assert.equal(calls(), 1);
  });
});

test('chat does not retry a 400 error', async () => {
  await withStub([{ status: 400, text: 'bad request' }, ok], async (calls) => {
    await assert.rejects(chat([{ role: 'user', content: 'x' }]), /LLM request failed with 400/);
    assert.equal(calls(), 1);
  });
});

// Review round 1 of PR #149: a connection that drops while the body is read is retried.
test('chat retries an interrupted 200 body and then succeeds', async () => {
  await withStub([{ status: 200, brokenBody: true }, ok], async (calls) => {
    assert.equal(await chat([{ role: 'user', content: 'x' }]), 'hello');
    assert.equal(calls(), 2);
  });
});

test('chat retries an interrupted 503 body and then succeeds', async () => {
  await withStub([{ status: 503, brokenBody: true }, ok], async (calls) => {
    assert.equal(await chat([{ role: 'user', content: 'x' }]), 'hello');
    assert.equal(calls(), 2);
  });
});
