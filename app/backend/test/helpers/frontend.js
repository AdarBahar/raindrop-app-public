// The page script as one text. index.html loads it in parts (core.js ... app.js). The tests that check the
// page script as text read all the parts, in the order of the page. datetime.js and rules.js are not part of it.
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../../../frontend/${name}`, import.meta.url), 'utf8');
const SHARED = new Set(['datetime.js', 'rules.js']);

// The file names of the page script, in the order of the <script> tags in index.html.
export const pageScriptFiles = () =>
  [...read('index.html').matchAll(/<script src="\/static\/([^"]+\.js)"><\/script>/g)]
    .map((m) => m[1])
    .filter((name) => !SHARED.has(name));

export const pageScript = () => pageScriptFiles().map(read).join('\n');
