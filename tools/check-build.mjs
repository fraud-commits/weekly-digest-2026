// Sanity checks for the bookmarklet build:
// 1. the bookmarklet decodes back to parseable JS;
// 2. it contains the expected entry points;
// 3. the landing page embeds the same code and links the draggable version.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const bookmarklet = await readFile(new URL('../docs/bo-checklist.bookmarklet.txt', import.meta.url), 'utf8');
const landing = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');

assert.ok(bookmarklet.startsWith('javascript:'), 'bookmarklet must use the javascript: scheme');

const decoded = decodeURIComponent(bookmarklet.slice('javascript:'.length));
new (await import('node:vm')).Script(decoded);

for (const marker of ['bo-checklist-dashboard', 'userTeamSelect', 'toCheck/index', 'parseTicketingRequests', 'REFRESH_MS']) {
  assert.ok(decoded.includes(marker), `missing marker: ${marker}`);
}

assert.ok(landing.includes('<script id="bm-code" type="text/plain">'), 'landing must embed the bookmarklet code');
assert.ok(landing.includes('href="javascript:'), 'landing must contain the draggable bookmark link');
assert.ok(!landing.includes('${'), 'landing template placeholders must be resolved');
assert.ok(!decoded.includes('PAGES_URL'), 'inline build must be self-contained');

console.log('PASS: bookmarklet decodes to valid JS, markers present, landing embeds the code');
