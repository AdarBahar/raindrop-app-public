import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareLinks, duplicateGroups, groupHash, linkKeys } from '../src/dupes.js';
import { pageScript } from './helpers/frontend.js';

// Each row: link A, link B, the expected class.
function check(rows) {
  for (const [a, b, want] of rows) assert.equal(compareLinks(a, b), want, `${a}  vs  ${b}`);
}

test('definite: the same page after tracking parameters, host case, port, plain fragment and parameter order', () => {
  check([
    ['https://example.com/article/123', 'https://example.com/article/123', 'definite'],
    ['https://example.com/article/123', 'https://example.com/article/123?utm_source=chatgpt.com', 'definite'],
    ['https://example.com/a?utm_source=x', 'https://example.com/a?utm_source=y&UTM_Medium=z', 'definite'],
    ['https://example.com/a?fbclid=1&gclid=2&msclkid=3&gbraid=4&wbraid=5&igshid=6&mc_cid=7&mc_eid=8&srsltid=9', 'https://example.com/a', 'definite'],
    ['https://example.com/p?b=2&a=1', 'https://example.com/p?a=1&b=2', 'definite'],
    ['https://EXAMPLE.com/p', 'https://example.com/p', 'definite'],
    ['https://example.com:443/p', 'https://example.com/p', 'definite'],
    ['http://example.com:80/p', 'http://example.com/p', 'definite'],
    ['https://example.com/p#section-2', 'https://example.com/p', 'definite'],
    ['https://example.com/%7Euser/a%2fb', 'https://example.com/~user/a%2Fb', 'definite'],
    ['https://example.com/p?a', 'https://example.com/p?a=', 'definite'],
  ]);
});

test('possible: only http or https, "www." or a "/" at the end differ', () => {
  check([
    ['http://example.com/p', 'https://example.com/p', 'possible'],
    ['https://www.example.com/p', 'https://example.com/p', 'possible'],
    ['https://example.com/p/', 'https://example.com/p', 'possible'],
    ['http://www.example.com/p/?utm_medium=mail', 'https://example.com/p', 'possible'],
  ]);
});

test('none: different pages on one site are never matched', () => {
  check([
    ['https://example.com/article/123', 'https://example.com/article/124', 'none'],
    ['https://example.com/page?id=1', 'https://example.com/page?id=2', 'none'],
    ['https://example.com/Page', 'https://example.com/page', 'none'], // the path case stays
    ['https://example.com/p?a=1', 'https://example.com/p', 'none'], // an unknown parameter stays
    ['https://example.com/p?ref=a', 'https://example.com/p?ref=b', 'none'],
    ['https://example.com/p?a=1&a=2', 'https://example.com/p?a=2&a=1', 'none'], // repeated values keep their order
    ['http://www.navigaya.tv/#/video/ee767949', 'http://www.navigaya.tv/#/video/ba163e67', 'none'],
    ['https://x.example/#!/a', 'https://x.example/#!/b', 'none'],
    ['https://docs.google.com/spreadsheets/d/abc/edit#gid=0', 'https://docs.google.com/spreadsheets/d/abc/edit#gid=123', 'none'],
    ['https://example.com:8080/p', 'https://example.com/p', 'none'],
    ['https://a.example.com/p', 'https://b.example.com/p', 'none'],
    ['http://efitriger.com/?p=27506', 'http://efitriger.com/?p=25703', 'none'],
    ['http://textologia.net/?page_id=1372', 'http://textologia.net/?p=5907', 'none'],
  ]);
});

test('GitHub: repositories, files, issues and pull requests stay apart', () => {
  check([
    ['https://github.com/user/repo1', 'https://github.com/user/repo2', 'none'],
    ['https://github.com/user/repo', 'https://github.com/user/repo/issues', 'none'],
    ['https://github.com/user/repo/issues/1', 'https://github.com/user/repo/issues/2', 'none'],
    ['https://github.com/user/repo/pull/1', 'https://github.com/user/repo/issues/1', 'none'],
    ['https://github.com/user/repo/blob/main/a.js', 'https://github.com/user/repo/blob/main/b.js', 'none'],
    ['https://github.com/user/repo/blob/main/A.js', 'https://github.com/user/repo/blob/main/a.js', 'none'],
    ['https://github.com/user/repo/commit/abc', 'https://github.com/user/repo/commit/abd', 'none'],
    ['https://github.com/user/repo/blob/main/README.md?tab=readme-ov-file', 'https://github.com/user/repo/blob/main/README.md', 'none'],
    ['https://github.com/user/repo?tab=other', 'https://github.com/user/repo', 'none'],
  ]);
  check([
    ['https://github.com/AykutSarac/jsoncrack.com?tab=readme-ov-file', 'https://github.com/AykutSarac/jsoncrack.com', 'definite'],
    ['https://github.com/user/repo/?tab=readme-ov-file', 'https://github.com/user/repo', 'possible'], // "/" at the end
    ['https://github.com/User/Repo', 'https://github.com/user/repo', 'definite'],
    ['https://www.github.com/user/repo', 'https://github.com/user/repo', 'definite'],
    ['http://github.com/user/repo', 'https://github.com/user/repo', 'possible'],
  ]);
});

test('X: a post ID is one post, on x.com and twitter.com', () => {
  check([
    ['https://x.com/user/status/111', 'https://x.com/user/status/222', 'none'],
    ['https://x.com/user/status/111', 'https://twitter.com/user/status/111', 'definite'],
    ['https://x.com/new_name/status/111', 'https://mobile.twitter.com/old_name/status/111?s=20&t=abc', 'definite'],
    ['https://x.com/i/web/status/111', 'https://x.com/user/status/111', 'definite'],
    ['https://x.com/user', 'https://x.com/user/status/111', 'none'],
    ['https://x.com/user', 'https://twitter.com/user', 'none'], // a profile has no safe rule
    ['https://x.com/user/status/111/photo/1', 'https://x.com/user/status/111', 'none'],
  ]);
});

test('YouTube: the video ID, and the playlist for a definite match', () => {
  check([
    ['https://youtube.com/watch?v=AAAAAAAAAAA', 'https://youtube.com/watch?v=BBBBBBBBBBB', 'none'],
    ['https://www.youtube.com/watch?ab_channel=X&v=dxQbKwOPpMo', 'https://youtu.be/dxQbKwOPpMo?si=abc', 'definite'],
    ['https://www.youtube.com/watch?v=dxQbKwOPpMo&t=2538s&feature=share&pp=x', 'http://youtube.com/watch?v=dxQbKwOPpMo', 'definite'],
    ['https://m.youtube.com/watch?v=dxQbKwOPpMo', 'https://www.youtube.com/shorts/dxQbKwOPpMo', 'definite'],
    ['https://youtube.com/watch?v=dxQbKwOPpMo&list=PL1', 'https://youtube.com/watch?v=dxQbKwOPpMo&list=PL1', 'definite'],
    ['https://youtube.com/watch?v=dxQbKwOPpMo&list=PL1', 'https://youtube.com/watch?v=dxQbKwOPpMo&list=PL2', 'possible'],
    ['https://youtube.com/watch?v=dxQbKwOPpMo&list=PL1', 'https://youtube.com/watch?v=dxQbKwOPpMo', 'possible'],
    ['https://youtube.com/watch?v=dxQbKwOPpMo&list=PL1&index=3', 'https://youtube.com/watch?v=dxQbKwOPpMo&list=PL1', 'possible'],
    ['https://youtube.com/watch?v=AAAAAAAAAAA&list=PL1', 'https://youtube.com/watch?v=BBBBBBBBBBB&list=PL1', 'none'],
    ['https://youtube.com/@channel', 'https://youtube.com/@other', 'none'],
  ]);
});

test('links that are not web links, and empty links', () => {
  assert.equal(linkKeys(''), null);
  assert.equal(linkKeys('   '), null);
  check([
    ['not a url', ' not a url ', 'definite'],
    ['not a url', 'not a url 2', 'none'],
    ['mailto:a@example.com', 'mailto:a@example.com', 'definite'],
    ['mailto:a@example.com', 'mailto:b@example.com', 'none'],
    ['ftp://example.com/a', 'https://example.com/a', 'none'],
    ['', '', 'none'],
  ]);
  // A text key never equals the key of a host.
  assert.equal(compareLinks('8080', 'http://text:8080/'), 'none');
});

test('international domain names match their punycode form', () => {
  check([
    ['https://münchen.de/a', 'https://xn--mnchen-3ya.de/a', 'definite'],
    ['https://münchen.de/a', 'https://munchen.de/a', 'none'],
  ]);
});

test('duplicateGroups counts each class, keeps metadata apart, and does not change the bookmarks', () => {
  const items = [
    { _id: 1, link: 'https://a.example/x', tags: ['one'], collection: { $id: 10 } },
    { _id: 2, link: 'https://a.example/x?utm_source=y', tags: ['two'], collection: { $id: 20 } },
    { _id: 3, link: 'http://a.example/x', tags: [], collection: { $id: -1 } },
    { _id: 4, link: 'https://b.example/', tags: [], collection: { $id: 10 } },
    { _id: 5, link: '', tags: [], collection: { $id: 10 } },
  ];
  const before = JSON.stringify(items);
  const { groups, info } = duplicateGroups(items);
  assert.equal(JSON.stringify(items), before);
  assert.deepEqual([1, 2, 3, 4, 5].map((id) => [info.get(id).dupes, info.get(id).maybe]), [[1, 1], [1, 1], [0, 2], [0, 0], [0, 0]]);
  assert.deepEqual(groups.map((g) => [g.section, g.ids]), [['definite', [1, 2]], ['possible', [1, 2, 3]]]);
  assert.equal(info.get(3).why, 'the links differ only in http or https, "www." or a "/" at the end');
  assert.equal(info.get(4).why, '');
});

test('duplicateGroups: a skipped bookmark is in no group, and a kept group shows again only with a new bookmark', () => {
  const items = [
    { _id: 1, link: 'https://a.example/x' },
    { _id: 2, link: 'https://a.example/x' },
    { _id: 3, link: 'https://a.example/x', archived: true },
  ];
  const skip = (item) => item.archived;
  const [group] = duplicateGroups(items, { skip }).groups;
  assert.deepEqual(group.ids, [1, 2]);
  assert.equal(group.hash, groupHash('definite', group.key));

  const kept = [{ hash: group.hash, ids: [1, 2] }];
  assert.deepEqual(duplicateGroups(items, { skip, kept }).groups, []);
  assert.equal(duplicateGroups(items, { skip, kept }).info.get(1).dupes, 0);
  // A bookmark that left the group keeps it hidden. A new bookmark shows it again.
  assert.deepEqual(duplicateGroups([items[0], items[1]], { kept: [{ hash: group.hash, ids: [1, 2, 9] }] }).groups, []);
  assert.deepEqual(duplicateGroups(items, { kept }).groups.map((g) => g.ids), [[1, 2, 3]]);
  // A group with one bookmark in the same definite key only is not a possible group.
  assert.deepEqual(duplicateGroups([items[0], items[1]]).groups.map((g) => g.section), ['definite']);
});

test('duplicateGroups on 20,000 bookmarks takes one pass, with no pairwise compare', () => {
  const items = [];
  for (let i = 0; i < 20000; i++) items.push({ _id: i, link: `https://site${i % 500}.example/article/${i % 10000}?utm_source=s${i}` });
  const t0 = performance.now();
  const { groups, info } = duplicateGroups(items);
  const ms = performance.now() - t0;
  // Each link is the same as one other link: i and i + 10000.
  assert.equal(groups.length, 10000);
  assert.equal(info.get(0).dupes, 1);
  assert.equal(info.get(10000).dupes, 1);
  assert.ok(ms < 2000, `took ${ms} ms`);
});

test('the frontend has one "Duplicates" option, the two sections, and the two group actions', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../../frontend/index.html', import.meta.url), 'utf8');
  const js = pageScript();
  assert.match(html, /<option value="dupes">Duplicates<\/option>/);
  assert.doesNotMatch(html, /value="maybe"/);
  assert.match(js, /section\('definite', 'Duplicates'\) \+ section\('possible', 'Possible duplicates'\)/);
  assert.match(js, /No duplicates found\./);
  assert.match(js, /data-keep-recent=/);
  assert.match(js, /data-keep-all=/);
  assert.match(js, /'\/api\/duplicates\/keep' : '\/api\/duplicates\/unkeep'/);
  // A bookmark in two groups shows one time, and the later header says so.
  assert.match(js, /const fresh = g\.ids\.filter\(id => !shown\.has\(id\)\);/);
  assert.match(js, /in a group above\./);
  // After "Keep all", the focus goes to Undo. A failed request redraws the list.
  assert.match(js, /if \(keep\) \$\('unkeepGroup'\)\?\.focus\(\);/);
  // "Keep recent" is off on a group with bookmarks in a group above, so it never moves a row that is not shown.
  assert.match(js, /disabled aria-describedby="dupeAbove\$\{i\}">Keep recent<\/button><span class="dupe-hint" id="dupeAbove\$\{i\}">Do the group above first\.<\/span>/);
});
