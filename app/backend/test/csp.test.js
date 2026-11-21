// The page's content security policy, its fonts, and what the page may load.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const frontend = new URL('../../frontend/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, frontend), 'utf8');
const html = read('index.html');
const css = read('styles.css');
const release = readFileSync(new URL('../../../deploy/build-release.sh', import.meta.url), 'utf8');

describe('content security policy', () => {
  let app;
  let base;
  before(async () => {
    const { createApp } = await import('../src/server.js');
    app = createApp({});
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.address().port}`;
  });
  after(() => app.close());

  test('the policy allows only the app itself, and no inline script', async () => {
    const res = await fetch(`${base}/`);
    const csp = res.headers.get('content-security-policy');
    const directive = (name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) ?? '';
    assert.equal(directive('default-src'), "default-src 'self'");
    assert.equal(directive('script-src'), "script-src 'self'");
    assert.ok(!/unsafe-inline|unsafe-eval/.test(directive('script-src')));
    assert.equal(directive('style-src'), "style-src 'self'");
    assert.equal(directive('connect-src'), "connect-src 'self'");
    assert.equal(directive('font-src'), "font-src 'self'");
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'same-origin');
  });
});

describe('the page and its fonts', () => {
  test('no third-party address is loaded by the page or the stylesheet', () => {
    // A link the user follows (the footer) is not a load. Only tags that load something are checked.
    assert.doesNotMatch(html, /<(link|script|img|iframe)\b[^>]*https?:\/\//);
    assert.doesNotMatch(html, /googleapis|gstatic/);
    assert.doesNotMatch(css, /googleapis|gstatic|https?:\/\//);
  });

  test('the page has no inline script and no inline event handler', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    assert.ok(scripts.every((attrs) => /\bsrc=/.test(attrs)), 'every script tag loads a file');
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  });

  test('every font the stylesheet names is in the frontend and in the release', () => {
    const files = [...css.matchAll(/url\('\/static\/fonts\/([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(files.length >= 5);
    for (const file of files) {
      assert.ok(existsSync(new URL(`fonts/${file}`, frontend)), `missing font file ${file}`);
    }
    assert.equal(readdirSync(new URL('fonts/', frontend)).filter((f) => f.endsWith('.woff2')).length, files.length);
    assert.match(release, /cp -R "\$here\/app\/frontend\/fonts" "\$R\/app\/frontend\/"/);
  });
});
