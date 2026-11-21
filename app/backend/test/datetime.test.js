import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The browser script defines localDateTime(). Load it the same way the page does.
const source = readFileSync(new URL('../../frontend/datetime.js', import.meta.url), 'utf8');
const sandbox = {};
vm.runInNewContext(`${source}\nthis.localDateTime = localDateTime;`, sandbox);
const { localDateTime } = sandbox;

test('one instant shows a different local time in two zones', () => {
  const instant = '2026-10-17T11:05:00.000Z';
  assert.equal(localDateTime(instant, 'America/New_York'), '17 Oct 2026, 07:05');
  assert.equal(localDateTime(instant, 'Asia/Jerusalem'), '17 Oct 2026, 14:05');
  assert.equal(localDateTime(instant, 'UTC'), '17 Oct 2026, 11:05');
});

test('a late evening in UTC is the next day in Jerusalem', () => {
  const instant = '2026-10-17T23:30:00.000Z';
  assert.equal(localDateTime(instant, 'Asia/Jerusalem'), '18 Oct 2026, 02:30');
  assert.equal(localDateTime(instant, 'UTC'), '17 Oct 2026, 23:30');
});

test('without a zone, the format is the same', () => {
  assert.match(localDateTime('2026-10-17T11:05:00.000Z'), /^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}$/);
});
