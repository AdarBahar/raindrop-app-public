import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decrypt, encrypt, loadOrCreateKey } from '../src/crypto.js';

test('encrypt then decrypt returns the original text', () => {
  const key = loadOrCreateKey(join(mkdtempSync(join(tmpdir(), 'rs-key-')), 'key'));
  const secret = 'access-token-value';
  const sealed = encrypt(secret, key);
  assert.notEqual(sealed, secret);
  assert.equal(decrypt(sealed, key), secret);
});

test('a different key or a changed value is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-key-'));
  const key = loadOrCreateKey(join(dir, 'key'));
  const other = loadOrCreateKey(join(mkdtempSync(join(tmpdir(), 'rs-key-')), 'key'));
  const sealed = encrypt('token', key);
  assert.throws(() => decrypt(sealed, other));
  const bytes = Buffer.from(sealed, 'base64');
  bytes[bytes.length - 1] ^= 1;
  assert.throws(() => decrypt(bytes.toString('base64'), key));
});

test('the key file is created with mode 600 and reused', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rs-key-')), 'key');
  const first = loadOrCreateKey(path);
  const second = loadOrCreateKey(path);
  assert.equal(first.toString('hex'), second.toString('hex'));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
