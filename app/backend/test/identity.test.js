// Identity comes only from the Admintools header. Cookies and other headers do not count.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { currentUser } from '../src/identity.js';

const req = (headers) => ({ headers });

describe('identity from the Admintools header', () => {
  test('a valid email is the user, in lower case', () => {
    assert.equal(currentUser(req({ 'x-admintools-email': 'Adar@Example.com' })), 'adar@example.com');
  });

  test('a missing header means no user', () => {
    assert.equal(currentUser(req({})), null);
  });

  test('the old cookie does not sign anyone in', () => {
    assert.equal(currentUser(req({ cookie: 'poc_user=alice' })), null);
  });

  test('a repeated header is refused', () => {
    assert.equal(currentUser(req({ 'x-admintools-email': 'a@example.test, b@example.test' })), null);
  });

  test('values that are not an email are refused', () => {
    for (const value of ['alice', 'alice@', '@example.test', 'a b@example.test', 'a@example', `${'a'.repeat(250)}@example.test`]) {
      assert.equal(currentUser(req({ 'x-admintools-email': value })), null, value);
    }
  });
});
