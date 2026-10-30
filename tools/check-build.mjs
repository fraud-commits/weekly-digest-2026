// Sanity checks for the bookmarklet build:
// 1. the static bookmarklet decodes back to parseable JS;
// 2. it contains the expected entry points;
// 3. the hosted script parses and matches the static build;
// 4. the loader bookmarklet is well-formed and points at the hosted script;
// 5. the landing page embeds both codes and links the draggable version.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const bookmarklet = await readFile(new URL('../docs/bo-checklist.bookmarklet.txt', import.meta.url), 'utf8');
const hosted = await readFile(new URL('../docs/bo-dashboard.js', import.meta.url), 'utf8');
const loader = await readFile(new URL('../docs/bo-checklist.loader.txt', import.meta.url), 'utf8');
const landing = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');

assert.ok(bookmarklet.startsWith('javascript:'), 'bookmarklet must use the javascript: scheme');

const decoded = decodeURIComponent(bookmarklet.slice('javascript:'.length));
const vm = await import('node:vm');
new vm.Script(decoded);
new vm.Script(hosted);
assert.equal(hosted, decoded, 'hosted script must match the static bookmarklet code');

for (const marker of ['bo-checklist-dashboard', 'userTeamSelect', 'toCheck/index', 'parseTicketingRequests', 'REFRESH_MS', 'DASHBOARD_CSS']) {
  assert.ok(decoded.includes(marker), `missing marker: ${marker}`);
}

assert.ok(loader.startsWith('javascript:'), 'loader must use the javascript: scheme');
assert.ok(loader.includes("bo-dashboard.js") && loader.includes("Date.now()"), 'loader must point at the hosted script with a cache buster');
assert.ok(loader.length < 400, `loader must stay tiny (got ${loader.length} chars)`);

assert.ok(landing.includes('<script id="bm-code" type="text/plain">'), 'landing must embed the static bookmarklet code');
assert.ok(landing.includes('<script id="bm-loader" type="text/plain">'), 'landing must embed the loader code');
assert.ok(landing.includes('href="javascript:'), 'landing must contain the draggable bookmark link');
assert.ok(!landing.includes('${'), 'landing template placeholders must be resolved');
assert.ok(!decoded.includes('PAGES_URL'), 'inline build must be self-contained');

console.log('PASS: builds are valid JS, markers present, landing embeds loader + static code');
