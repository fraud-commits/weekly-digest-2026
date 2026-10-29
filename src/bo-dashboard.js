/*!
 * BO Checklist Dashboard (bookmarklet build)
 * Runs inside an authenticated lfscbo.com page. No server, no extension.
 * Reuses the parsing flow of the local server build (overview only).
 * Rendering is fully inline-styled so page CSS, re-renders and CSP cannot hide it.
 */
(function () {
  "use strict";

  if (!/lfscbo\.com$/i.test(location.hostname)) {
    alert("Open this on lfscbo.com");
    return;
  }

  const PANEL_ID = "bo-checklist-dashboard";
  const TIMER_FLAG = "__boChecklistTimer";
  const CLOSED_FLAG = "__boChecklistClosed";
  const REFRESH_MS = 5 * 60 * 1000;
  const LATE_TAB_WAIT_MS = 1200;
  const LATE_TAB_MAX_ATTEMPTS = 4;
  const QUICK_REPORT_LATE_CLIENTS = new Set(["Mac88", "Royal Gaming"]);
  const SCAN_STEP_DELAY_MS = 250;
  const NIGHT_ONLY_TYPES = new Set(["robotPlayers", "dealerPlayerMargin"]);
  const NIGHT_FILTER_STORAGE_KEY = "bo-checklist-ignore-night-only-v1";

  if (window[TIMER_FLAG]) {
    window.clearTimeout(window[TIMER_FLAG]);
    window[TIMER_FLAG] = null;
  }
  window[CLOSED_FLAG] = false;

  document.getElementById(PANEL_ID)?.remove();
  document.getElementById(`${PANEL_ID}-style`)?.remove();

  const VERSION = "v1";

  let currentPayload = null;
  let isScanning = false;
  let userConsented = false;
  let ignoreNightOnly = localStorage.getItem(NIGHT_FILTER_STORAGE_KEY) === "1";
  let originalClientId = null;
  let statusLine = "Ready. Press Scan.";

  const root = document.createElement("div");
  root.id = PANEL_ID;
  root.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "z-index:2147483000",
    "width:min(780px,94vw)",
    "max-height:74vh",
    "overflow:auto",
    "background:#043927",
    "color:#EFFFFB",
    'font:13px/1.45 "Segoe UI",system-ui,sans-serif',
    "border:1px solid rgba(239,255,251,.16)",
    "border-radius:16px",
    "box-shadow:0 24px 60px rgba(0,0,0,.45)",
    "padding:0",
    "margin:0",
  ].join(";");
  document.body.appendChild(root);

  // Self-healing: if the host page re-renders and drops the panel, put it back.
  const heartbeat = window.setInterval(() => {
    if (window[CLOSED_FLAG]) {
      window.clearInterval(heartbeat);
      return;
    }
    if (!root.isConnected) {
      document.body.appendChild(root);
    }
  }, 1500);

  function mk(tag, cssText, html) {
    const node = document.createElement(tag);
    if (cssText) {
      node.style.cssText = cssText;
    }
    if (html != null) {
      node.innerHTML = html;
    }
    return node;
  }

  function mkBtn(label, onClick, disabled) {
    const button = mk(
      "button",
      [
        "border:1px solid rgba(239,255,251,.16)",
        "border-radius:10px",
        "padding:7px 12px",
        'font:700 12px/1 "Segoe UI",system-ui,sans-serif',
        "color:#EFFFFB",
        "background:rgba(239,255,251,.10)",
        "cursor:pointer",
        disabled ? "opacity:.5" : "",
      ]
        .filter(Boolean)
        .join(";"),
      escapeHtml(label),
    );
    if (disabled) {
      button.disabled = true;
    } else {
      button.addEventListener("click", onClick);
    }
    return button;
  }

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

  function addStat(statsGrid, value, label) {
    statsGrid.appendChild(
      mk(
        "div",
        "background:rgba(239,255,251,.06);border:1px solid rgba(239,255,251,.10);border-radius:12px;padding:10px 12px;display:grid;gap:2px;",
        `<strong style="font-size:18px;">${escapeHtml(value)}</strong><span style="font-size:11px;color:rgba(239,255,251,.65);">${escapeHtml(label)}</span>`,
      ),
    );
  }

  function addChip(cell, label, count, isQuick) {
    cell.appendChild(
      mk(
        "span",
        [
          "display:inline-block;margin:2px 4px 2px 0;padding:3px 8px;border-radius:999px;font-size:11px;",
          isQuick
            ? "background:rgba(0,152,125,.25);border:1px solid rgba(0,152,125,.5);"
            : "background:rgba(239,255,251,.08);border:1px solid rgba(239,255,251,.12);",
        ].join(""),
        `${escapeHtml(label)} ${escapeHtml(count)}`,
      ),
    );
  }

  function render(payload, extra = {}) {
    const data = payload ? applyNightOnlyFilter(payload) : null;
    const clients = data?.clients || [];
    const uncheckedCases = clients.reduce((sum, client) => sum + client.total, 0);
    const clientsWithBacklog = clients.filter((client) => client.total > 0).length;
    const largest = [...clients].sort((a, b) => b.total - a.total)[0] || null;
    const minimized = root.dataset.minimized === "1";

    root.innerHTML = "";

    const head = mk(
      "div",
      "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(239,255,251,.12);position:sticky;top:0;background:#043927;z-index:2;",
    );
    head.appendChild(
      mk(
        "div",
        "font-weight:800;letter-spacing:-.01em;",
        `BO Checklist <span style="color:#00987D;font-size:11px;margin-left:6px;font-weight:700;">${escapeHtml(VERSION)}</span>`,
      ),
    );

    const tools = mk("div", "display:flex;gap:6px;");
    tools.appendChild(
      mkBtn(ignoreNightOnly ? "Include night tabs" : "Hide night tabs", () => {
        ignoreNightOnly = !ignoreNightOnly;
        localStorage.setItem(NIGHT_FILTER_STORAGE_KEY, ignoreNightOnly ? "1" : "0");
        render(currentPayload);
      }),
    );
    tools.appendChild(mkBtn(isScanning ? "Scanning..." : "Scan", () => runScan(true), isScanning));
    tools.appendChild(
      mkBtn(minimized ? "Show" : "Hide", () => {
        root.dataset.minimized = minimized ? "0" : "1";
        render(currentPayload);
      }),
    );
    tools.appendChild(
      mkBtn("Close", () => {
        window[CLOSED_FLAG] = true;
        window.clearInterval(heartbeat);
        window.clearTimeout(window[TIMER_FLAG]);
        window[TIMER_FLAG] = null;
        root.remove();
      }),
    );
    head.appendChild(tools);
    root.appendChild(head);

    root.appendChild(
      mk(
        "div",
        "padding:10px 14px;color:rgba(239,255,251,.75);border-bottom:1px solid rgba(239,255,251,.08);",
        `${escapeHtml(extra.progressLine || statusLine)} · Updated ${escapeHtml(formatStamp(data?.snapshotDate))}`,
      ),
    );

    if (minimized) {
      return;
    }

    const statsGrid = mk("div", "display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:12px 14px;");
    addStat(statsGrid, uncheckedCases, "Unchecked total");
    addStat(statsGrid, clientsWithBacklog, "Clients with work");
    addStat(statsGrid, largest?.client || "—", "Largest backlog");
    addStat(statsGrid, data?.ticketing?.requests ?? "—", "Ticketing requests");
    root.appendChild(statsGrid);

    if (data?.warnings?.length) {
      data.warnings.forEach((line) => {
        root.appendChild(
          mk(
            "div",
            "margin:0 14px 10px;padding:10px 12px;border-radius:10px;background:rgba(214,75,109,.18);border:1px solid rgba(214,75,109,.35);color:#ffd9e2;",
            escapeHtml(line),
          ),
        );
      });
    }

    const tableWrap = mk("div", "padding:0 14px 14px;overflow:auto;");
    const table = mk("table", "width:100%;border-collapse:collapse;font-size:12.5px;");
    const thead = mk("thead");
    const headRow = mk("tr");
    ["Client", "Total", "Non-zero tabs"].forEach((title) => {
      headRow.appendChild(
        mk(
          "th",
          "text-align:left;padding:8px 10px;border-bottom:1px solid rgba(239,255,251,.08);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:rgba(239,255,251,.6);background:#062d1e;",
          escapeHtml(title),
        ),
      );
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = mk("tbody");
    if (!clients.length) {
      const emptyRow = mk("tr");
      emptyRow.appendChild(
        mk(
          "td",
          "text-align:center;color:rgba(239,255,251,.6);padding:18px;",
          "No data yet. Press Scan.",
        ),
      );
      emptyRow.firstChild.colSpan = 3;
      tbody.appendChild(emptyRow);
    }
    clients.forEach((client) => {
      const row = mk("tr");
      row.appendChild(
        mk("td", "text-align:left;padding:8px 10px;border-bottom:1px solid rgba(239,255,251,.08);vertical-align:top;", escapeHtml(client.client)),
      );
      row.appendChild(
        mk(
          "td",
          `text-align:left;padding:8px 10px;border-bottom:1px solid rgba(239,255,251,.08);vertical-align:top;font-weight:800;color:${client.total > 0 ? "#7CE3C3" : "rgba(239,255,251,.4)"};`,
          escapeHtml(client.total),
        ),
      );
      const tabsCell = mk("td", "text-align:left;padding:8px 10px;border-bottom:1px solid rgba(239,255,251,.08);vertical-align:top;");
      (client.nonZero || []).forEach((item) => {
        addChip(tabsCell, item.label, item.count, item.type === "quickReports");
      });
      row.appendChild(tabsCell);
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    root.appendChild(tableWrap);
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

      window.clearTimeout(window[TIMER_FLAG]);
      window[TIMER_FLAG] = window.setTimeout(runScan, REFRESH_MS);
    }
  }

  root.dataset.minimized = "0";
  render(null);
  runScan("manual");
})();
