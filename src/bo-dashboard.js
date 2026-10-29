/*!
 * BO Checklist Dashboard (bookmarklet build)
 * Runs inside an authenticated lfscbo.com page. No server, no extension.
 * Reuses the parsing flow of the local server build (overview only, v1).
 */
(function () {
  "use strict";

  if (!/lfscbo\.com$/i.test(location.hostname)) {
    alert("Open this on lfscbo.com");
    return;
  }

  const PANEL_ID = "bo-checklist-dashboard";
  const REFRESH_MS = 5 * 60 * 1000;
  const LATE_TAB_WAIT_MS = 1200;
  const LATE_TAB_MAX_ATTEMPTS = 4;
  const QUICK_REPORT_LATE_CLIENTS = new Set(["Mac88", "Royal Gaming"]);
  const SCAN_STEP_DELAY_MS = 250;
  const NIGHT_ONLY_TYPES = new Set(["robotPlayers", "dealerPlayerMargin"]);
  const NIGHT_FILTER_STORAGE_KEY = "bo-checklist-ignore-night-only-v1";
  const VERSION = "v1";

  if (window.__boChecklistTimer) {
    window.clearTimeout(window.__boChecklistTimer);
    window.__boChecklistTimer = null;
  }

  document.getElementById(PANEL_ID)?.remove();

  let currentHeight = 0;
  let currentPayload = null;
  let isScanning = false;
  let userConsented = false;
  let ignoreNightOnly = localStorage.getItem(NIGHT_FILTER_STORAGE_KEY) === "1";
  let originalClientId = null;
  let statusLine = "Ready. Press Scan.";

  const root = document.createElement("div");
  root.id = PANEL_ID;

  function ensureStyles() {
    if (document.getElementById(`${PANEL_ID}-style`)) {
      return;
    }
    const style = document.createElement("style");
    style.id = `${PANEL_ID}-style`;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed; right: 16px; bottom: 16px; z-index: 999999;
        width: min(780px, 94vw); max-height: 74vh;
        font: 13px/1.45 "Segoe UI", system-ui, sans-serif;
      }
      #${PANEL_ID} .bc-card {
        width: 100%; max-height: 74vh; overflow: auto;
        background: #043927; color: #EFFFFB;
        border: 1px solid rgba(239,255,251,.16); border-radius: 16px;
        box-shadow: 0 24px 60px rgba(0,0,0,.45);
      }
      #${PANEL_ID} .bc-head {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 12px 14px; border-bottom: 1px solid rgba(239,255,251,.12);
        position: sticky; top: 0; background: #043927; z-index: 2;
      }
      #${PANEL_ID} .bc-title { font-weight: 800; letter-spacing: -.01em; }
      #${PANEL_ID} .bc-ver { color: #00987D; font-size: 11px; margin-left: 6px; font-weight: 700; }
      #${PANEL_ID} .bc-tools { display: flex; gap: 6px; }
      #${PANEL_ID} .bc-btn {
        border: 1px solid rgba(239,255,251,.16); border-radius: 10px; padding: 7px 12px;
        font: 700 12px/1 "Segoe UI", system-ui, sans-serif; color: #EFFFFB;
        background: rgba(239,255,251,.10); cursor: pointer;
      }
      #${PANEL_ID} .bc-btn:hover { background: rgba(0,152,125,.35); }
      #${PANEL_ID} .bc-btn.disabled { opacity: .5; cursor: default; }
      #${PANEL_ID} .bc-status {
        padding: 10px 14px; color: rgba(239,255,251,.75);
        border-bottom: 1px solid rgba(239,255,251,.08);
      }
      #${PANEL_ID} .bc-stats {
        display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 12px 14px;
      }
      #${PANEL_ID} .bc-stat {
        background: rgba(239,255,251,.06); border: 1px solid rgba(239,255,251,.10);
        border-radius: 12px; padding: 10px 12px; display: grid; gap: 2px;
      }
      #${PANEL_ID} .bc-stat strong { font-size: 18px; }
      #${PANEL_ID} .bc-stat span { font-size: 11px; color: rgba(239,255,251,.65); }
      #${PANEL_ID} .bc-warn {
        margin: 0 14px 10px; padding: 10px 12px; border-radius: 10px;
        background: rgba(214,75,109,.18); border: 1px solid rgba(214,75,109,.35); color: #ffd9e2;
      }
      #${PANEL_ID} .bc-tablewrap { padding: 0 14px 14px; overflow: auto; }
      #${PANEL_ID} .bc-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
      #${PANEL_ID} .bc-table th, #${PANEL_ID} .bc-table td {
        text-align: left; padding: 8px 10px; border-bottom: 1px solid rgba(239,255,251,.08); vertical-align: top;
      }
      #${PANEL_ID} .bc-table th {
        font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
        color: rgba(239,255,251,.6); background: #062d1e;
      }
      #${PANEL_ID} .bc-total { font-weight: 800; }
      #${PANEL_ID} .bc-total.hot { color: #7CE3C3; }
      #${PANEL_ID} .bc-total.zero { color: rgba(239,255,251,.4); }
      #${PANEL_ID} .bc-chip {
        display: inline-block; margin: 2px 4px 2px 0; padding: 3px 8px; border-radius: 999px;
        background: rgba(239,255,251,.08); border: 1px solid rgba(239,255,251,.12); font-size: 11px;
      }
      #${PANEL_ID} .bc-chip.quick { background: rgba(0,152,125,.25); border-color: rgba(0,152,125,.5); }
      #${PANEL_ID} .bc-empty { text-align: center; color: rgba(239,255,251,.6); padding: 18px; }
    `;
    document.head.appendChild(style);
  }

  ensureStyles();
  document.body.appendChild(root);

  function decodeHtml(input = "") {
    return input
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  function stripTags(html = "") {
    return decodeHtml(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  }

  function escapeHtml(text) {
    return String(text ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function getIsoDate(date = new Date()) {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function formatStamp(value) {
    if (!value) {
      return "No updates yet";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "Unknown";
    }
    return date.toLocaleTimeString("en-GB", { hour12: false });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function boFetch(pathname) {
    const response = await fetch(pathname, {
      credentials: "same-origin",
      referer: `${location.origin}/`,
    });
    if (!response.ok) {
      throw new Error(`BO ${pathname} → HTTP ${response.status}`);
    }
    return response.text();
  }

  function isLoginPage(html) {
    return /name="key" value=/i.test(html) && !/userTeamSelect/i.test(html);
  }

  function parseClientsFromHtml(html) {
    const selectMatch = html.match(/<select[\s\S]*?id="userTeamSelect"[\s\S]*?>([\s\S]*?)<\/select>/i);
    if (!selectMatch) {
      return [];
    }

    return [...selectMatch[1].matchAll(/<option value="([^"]+)"([^>]*)>([^<]+)<\/option>/gi)]
      .map((match) => ({
        id: match[1],
        client: stripTags(match[3]),
        selected: /\bselected\b/i.test(match[2]),
      }));
  }

  function parseTabsFromHtml(html) {
    return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
      .map((match) => {
        const attrs = match[1] || "";
        const inner = match[2];
        const dataTypeMatch = attrs.match(/\bdata-type="([^"]+)"/i);
        const hrefMatch = attrs.match(/\bhref="([^"]+)"/i);
        const href = hrefMatch ? hrefMatch[1].replace(/&amp;/g, "&") : "";
        const hrefTypeMatch = href.match(/[?&]type=([^&"]+)/i);
        const type = dataTypeMatch ? dataTypeMatch[1] : hrefTypeMatch ? hrefTypeMatch[1] : "";

        if (!type) {
          return null;
        }

        const disabledByCoffee = /\bcoffee\b/i.test(inner) || /☕/u.test(inner);
        const badgeHtmlMatch = inner.match(/<i[^>]*>([\s\S]*?)<\/i>/i);
        const badgeText = badgeHtmlMatch ? stripTags(badgeHtmlMatch[1]) : "";
        const badgeCountMatch = badgeText.match(/(\d+)/);
        const labelHtml = inner.replace(/<i[^>]*>[\s\S]*?<\/i>/gi, "");

        return {
          type,
          label: stripTags(labelHtml),
          count: disabledByCoffee ? 0 : badgeCountMatch ? Number(badgeCountMatch[1]) : 0,
          disabled: disabledByCoffee,
        };
      })
      .filter(Boolean);
  }

  function getQuickReportsCount(tabs = []) {
    const quickTab = tabs.find((tab) => /quick\s*reports?/i.test(tab.label) || /quick/i.test(tab.type));
    return quickTab ? quickTab.count : 0;
  }

  function parseTicketingRequests(html) {
    const headings = [...String(html).matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)];
    for (const heading of headings) {
      const text = heading[2].replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").trim();
      if (/^Ticketing$/i.test(text)) return 0;
      const match = text.match(/^Ticketing\s+(\d+)$/i);
      if (match && Number.isSafeInteger(Number(match[1]))) return Number(match[1]);
    }
    return null;
  }

  async function fetchToCheckHtml(isoDate) {
    return boFetch(
      `/ajax.php?q=lfs/toCheck/index&selectFrom=${encodeURIComponent(isoDate)}&selectTo=${encodeURIComponent(isoDate)}`,
    );
  }

  async function fetchToCheckHtmlWithLateTabs(isoDate, clientName) {
    let lastText = "";
    let previousSignature = "";
    let stablePasses = 0;

    for (let attempt = 1; attempt <= LATE_TAB_MAX_ATTEMPTS; attempt += 1) {
      const text = await fetchToCheckHtml(isoDate);
      lastText = text;
      const tabs = parseTabsFromHtml(text);
      const quickReportsCount = getQuickReportsCount(tabs);
      const signature = `${tabs.length}:${quickReportsCount}:${tabs.map((tab) => `${tab.type}:${tab.count}`).join("|")}`;

      if (signature === previousSignature) {
        stablePasses += 1;
      } else {
        previousSignature = signature;
        stablePasses = 0;
      }

      if (!QUICK_REPORT_LATE_CLIENTS.has(clientName)) {
        return text;
      }

      if (quickReportsCount > 0) {
        return text;
      }

      if (stablePasses >= 1) {
        return text;
      }

      if (attempt < LATE_TAB_MAX_ATTEMPTS) {
        await sleep(LATE_TAB_WAIT_MS);
      }
    }

    return lastText;
  }

  function collectClient(clientRef, toCheckHtml) {
    const tabs = parseTabsFromHtml(toCheckHtml);
    const nonZero = tabs.filter((tab) => tab.count > 0);
    const total = nonZero.reduce((sum, tab) => sum + tab.count, 0);

    return {
      clientId: clientRef.id,
      client: clientRef.client,
      total,
      quickReports: getQuickReportsCount(nonZero),
      nonZero,
    };
  }

  function applyNightOnlyFilter(payload) {
    if (!ignoreNightOnly) {
      return payload;
    }

    const clients = payload.clients.map((client) => {
      const nonZero = (client.nonZero || []).filter((item) => !NIGHT_ONLY_TYPES.has(item.type));
      const total = nonZero.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
      return { ...client, total, nonZero };
    });

    return { ...payload, clients: [...clients].sort((a, b) => b.total - a.total || a.client.localeCompare(b.client)) };
  }

  function render(payload, extra = {}) {
    const data = payload ? applyNightOnlyFilter(payload) : null;
    const clients = data?.clients || [];
    const uncheckedCases = clients.reduce((sum, client) => sum + client.total, 0);
    const clientsWithBacklog = clients.filter((client) => client.total > 0).length;
    const largest = [...clients].sort((a, b) => b.total - a.total)[0] || null;
    const minimized = root.dataset.minimized === "1";

    const rows = clients
      .map(
        (client) => `
        <tr>
          <td class="bc-client">${escapeHtml(client.client)}</td>
          <td class="bc-total ${client.total > 0 ? "hot" : "zero"}">${escapeHtml(client.total)}</td>
          <td class="bc-tabs">
            ${(client.nonZero || [])
              .map(
                (item) =>
                  `<span class="bc-chip ${item.type === "quickReports" ? "quick" : ""}">${escapeHtml(item.label)} ${escapeHtml(item.count)}</span>`,
              )
              .join("")}
          </td>
        </tr>`,
      )
      .join("");

    root.innerHTML = `
      <div class="bc-card">
        <div class="bc-head">
          <div class="bc-title">BO Checklist <span class="bc-ver">${escapeHtml(VERSION)}</span></div>
          <div class="bc-tools">
            <button type="button" class="bc-btn" data-act="night">${ignoreNightOnly ? "Include night tabs" : "Hide night tabs"}</button>
            <button type="button" class="bc-btn ${isScanning ? "disabled" : ""}" data-act="scan">${isScanning ? "Scanning..." : "Scan"}</button>
            <button type="button" class="bc-btn" data-act="min">${minimized ? "Show" : "Hide"}</button>
            <button type="button" class="bc-btn" data-act="close">Close</button>
          </div>
        </div>

        ${
          minimized
            ? ""
            : `
        <div class="bc-status">${escapeHtml(extra.progressLine || statusLine)} · Updated ${escapeHtml(formatStamp(data?.snapshotDate))}</div>

        <div class="bc-stats">
          <div class="bc-stat"><strong>${escapeHtml(uncheckedCases)}</strong><span>Unchecked total</span></div>
          <div class="bc-stat"><strong>${escapeHtml(clientsWithBacklog)}</strong><span>Clients with work</span></div>
          <div class="bc-stat"><strong>${escapeHtml(largest?.client || "—")}</strong><span>Largest backlog</span></div>
          <div class="bc-stat"><strong>${escapeHtml(data?.ticketing?.requests ?? "—")}</strong><span>Ticketing requests</span></div>
        </div>

        ${
          data?.warnings?.length
            ? `<div class="bc-warn">${data.warnings.map((line) => escapeHtml(line)).join("<br>")}</div>`
            : ""
        }

        <div class="bc-tablewrap">
          <table class="bc-table">
            <thead>
              <tr><th>Client</th><th>Total</th><th>Non-zero tabs</th></tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="3" class="bc-empty">No data yet. Press Scan.</td></tr>`}
            </tbody>
          </table>
        </div>
        `
        }
      </div>
    `;

    root.querySelectorAll("[data-act]").forEach((button) => {
      const action = button.dataset.act;
      if (action === "scan" && isScanning) {
        return;
      }
      button.addEventListener("click", () => {
        if (action === "scan") {
          runScan(true);
        }
        if (action === "night") {
          ignoreNightOnly = !ignoreNightOnly;
          localStorage.setItem(NIGHT_FILTER_STORAGE_KEY, ignoreNightOnly ? "1" : "0");
          render(currentPayload);
        }
        if (action === "min") {
          root.dataset.minimized = minimized ? "0" : "1";
          render(currentPayload);
        }
        if (action === "close") {
          window.clearTimeout(window.__boChecklistTimer);
          window.__boChecklistTimer = null;
          root.remove();
        }
      });
    });
  }

  function restoreOriginalClient() {
    if (!originalClientId) {
      return;
    }
    boFetch(`/ajax.php?q=core/userTeamSelect&type=lfs&val=${encodeURIComponent(originalClientId)}`).catch(() => {});
    const select = document.getElementById("userTeamSelect");
    if (select) {
      select.value = originalClientId;
    }
  }

  async function runScan(force = false) {
    if (isScanning) {
      return;
    }

    if (!userConsented) {
      userConsented = window.confirm(
        "BO Checklist: a scan switches the active BO client in THIS browser session.\n\n" +
          "Recommended: run this in a separate browser or an incognito window with its own BO login, " +
          "not in the browser you work in.\n\nStart the scan here?",
      );
      if (!userConsented) {
        statusLine = "Scan cancelled. Open lfscbo.com in a separate browser session and press Scan there.";
        if (!currentPayload) {
          currentPayload = { snapshotDate: null, ticketing: null, clients: [], warnings: [] };
        }
        render(currentPayload);
        return;
      }
    }

    isScanning = true;
    currentHeight = 0;
    statusLine = "Scanning...";
    render(currentPayload);

    try {
      const isoDate = getIsoDate();
      const baseHtml = await fetchToCheckHtml(isoDate);

      if (isLoginPage(baseHtml)) {
        throw new Error("BO session expired. Log in to lfscbo.com again.");
      }

      const clients = parseClientsFromHtml(baseHtml);
      if (!clients.length) {
        throw new Error("Could not parse client list from BO");
      }

      originalClientId = clients.find((client) => client.selected)?.id || null;
      const ticketingRequests = await fetch("/ajax.php?q=lfs/ticketing", { credentials: "same-origin" })
        .then((response) => response.text())
        .then(parseTicketingRequests)
        .catch(() => null);

      const results = [];
      for (let index = 0; index < clients.length; index += 1) {
        const clientRef = clients[index];
        statusLine = `Scanning ${index + 1} / ${clients.length}`;
        render(null, { progressLine: `${statusLine} — ${clientRef.client}` });

        await boFetch(`/ajax.php?q=core/userTeamSelect&type=lfs&val=${encodeURIComponent(clientRef.id)}`);
        const toCheckHtml = await fetchToCheckHtmlWithLateTabs(isoDate, clientRef.client);
        results.push(collectClient(clientRef, toCheckHtml));
        await sleep(SCAN_STEP_DELAY_MS);
      }

      restoreOriginalClient();

      const sorted = [...results].sort((a, b) => b.total - a.total || a.client.localeCompare(b.client));
      currentPayload = {
        snapshotDate: new Date().toISOString(),
        requestedDate: isoDate,
        ticketing: { requests: ticketingRequests },
        clients: sorted,
        warnings: [],
      };
      statusLine = "Done.";
      render(currentPayload);
    } catch (error) {
      statusLine = `Error: ${error.message}`;
      currentPayload = currentPayload
        ? { ...currentPayload, warnings: [statusLine] }
        : { snapshotDate: null, ticketing: null, clients: [], warnings: [statusLine] };
      restoreOriginalClient();
      render(currentPayload);
    } finally {
      isScanning = false;
      render(currentPayload);

      if (force !== "manual") {
        window.clearTimeout(window.__boChecklistTimer);
        window.__boChecklistTimer = window.setTimeout(runScan, REFRESH_MS);
      }
    }
  }

  currentHeight = 0;
  root.dataset.minimized = "0";
  render(null);
  runScan("manual");
})();
