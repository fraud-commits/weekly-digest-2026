// Builds the bookmarklet from src/bo-dashboard.js
// Output (docs/ is the GitHub Pages source, branch main /docs):
//   docs/bo-checklist.bookmarklet.txt  — one-liner to paste as a bookmark URL
//   docs/index.html                    — GitHub Pages landing (install instructions + drag link)
//
// Usage: node tools/build-bookmarklet.mjs [<version>]
// Optional env: PAGES_URL (absolute URL of hosted bo-dashboard.js for the loader variant)

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const srcPath = path.join(projectRoot, "src", "bo-dashboard.js");
const distPath = path.join(projectRoot, "docs");

const version = process.argv[2] || "v1";
const code0 = await readFile(srcPath, "utf8");
const code = code0.replace(
  'const VERSION = "v1";',
  `const VERSION = ${JSON.stringify(version)};`,
);
if (code === code0) {
  console.error("WARN: VERSION placeholder not found, using source value");
}

// Syntax gate: fail the build on invalid JS instead of shipping a broken bookmark.
new vm.Script(code);

const bookmarklet = "javascript:" + encodeURIComponent(code);

const landing = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BO Checklist Dashboard — install</title>
  <style>
    :root { --accent:#00987D; --dark:#043927; --mint:#EFFFFB; }
    body { margin:0; min-height:100vh; font-family:"Segoe UI",system-ui,sans-serif; color:var(--mint); background:linear-gradient(160deg,#043927,#000E0B); }
    main { max-width:760px; margin:0 auto; padding:48px 24px; }
    h1 { color:var(--accent); letter-spacing:-0.02em; }
    .card { background:rgba(239,255,251,0.06); border:1px solid rgba(239,255,251,0.14); border-radius:18px; padding:24px; margin-top:24px; }
    .step { margin:14px 0; line-height:1.6; }
    a.drag-probe:active { cursor:grabbing; }
    .drag-link { display:inline-block; padding:12px 22px; border-radius:12px; background:var(--accent); color:#fff; text-decoration:none; font-weight:700; }
    code { background:rgba(0,244,187,0.12); padding:2px 6px; border-radius:6px; }
  </style>
</head>
<body>
  <main>
    <h1>BO Checklist Dashboard</h1>
    <p>Bookmarklet build ${version}. Live "Data to check" overview over your own BO session — no server, no extension.</p>

    <div class="card">
      <div class="step"><strong>1.</strong> Copy the bookmarklet code:</div>
      <div class="step"><button id="copy-button" type="button" style="padding:10px 18px;border-radius:10px;border:0;background:#00987D;color:#fff;font-weight:700;cursor:pointer;">Copy bookmarklet code</button></div>

      <div class="step"><strong>2.</strong> In your browser: right-click the bookmarks bar → Add page... → name it <code>BO Checklist</code> and paste the copied code into the URL field. Alternatively, drag this button to the bookmarks bar:</div>
      <div class="step"><a class="drag-link" href="${bookmarklet}">BO Checklist ↗ (drag me)</a></div>

      <div class="step"><strong>3.</strong> Open and log in to lfscbo.com as usual, then click the <code>BO Checklist</code> bookmark. The panel appears and scans all clients (2–4 minutes on the first pass).</div>
    </div>

    <div class="card">
      <strong>Notes</strong>
      <p style="line-height:1.6;">The scan switches BO's active client in the background; your original selection is restored at the end. Auto-refresh runs every 5 minutes while the tab stays open. Keep the page open in a regular (not incognito) profile so the BO session persists.</p>
    </div>
<script>
document.getElementById("copy-button").addEventListener("click", async function () {
  var codeElement = document.getElementById("bm-code");
  var source = codeElement.textContent;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(source);
  } else {
    var area = document.createElement("textarea");
    area.value = source;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  this.textContent = "Copied!";
  setTimeout(function () { this.textContent = "Copy bookmarklet code"; }.bind(this), 1500);
});
</script>
  </main>
  <script id="bm-code" type="text/plain">${bookmarklet}</script>
</body>
</html>
`;

// Bookmarklet text is stored as plain text outside HTML context only in dist
// artifacts. In the landing page it is embedded in attribute-escaped form.
await mkdir(distPath, { recursive: true });
await writeFile(path.join(distPath, "bo-checklist.bookmarklet.txt"), bookmarklet, "utf8");
await writeFile(path.join(distPath, "index.html"), landing, "utf8");

const pagesUrl = process.env.PAGES_URL || "";
if (pagesUrl) {
  const loader = `javascript:(function(){var s=document.createElement('script');s.src=${JSON.stringify(pagesUrl)};document.body.appendChild(s);}());`;
  await writeFile(path.join(distPath, "bo-checklist.loader.txt"), loader, "utf8");
  console.log(`loader bookmarklet → ${distPath}\\bo-checklist.loader.txt (${pagesUrl})`);
}

console.log(`PASS: bookmarklet build ${version} — docs/index.html, docs/bo-checklist.bookmarklet.txt (${bookmarklet.length} chars)`);
