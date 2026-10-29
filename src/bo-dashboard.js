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
  const MODE_STORAGE_KEY = "bo-checklist-mode-v1";
  const THEME_STORAGE_KEY = "bo-checklist-theme-v1";
  const WINNER_WAIT_MS = 2000;
  const WINNER_CONFIRM_WAIT_MS = 1000;
  const WINNER_MAX_POLLING_ATTEMPTS = 8;
  const WINNER_MAX_LOADING_MS = 45 * 1000;
  const WINNER_AGG_THRESHOLD = 20000;
  const WINNER_AGG_CONCURRENCY = 3;
  const MAILING_TAB_LABELS = new Set([
    "sempris winners",
    "winners",
    "sempris opposite",
    "opposite",
    "fraud report",
    "investigation requests",
  ]);

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
  let fullscreen = localStorage.getItem(MODE_STORAGE_KEY) === "full";
  let lightMode = localStorage.getItem(THEME_STORAGE_KEY) !== "dark";
  let originalClientId = null;
  let statusLine = "Ready. Press Scan.";

  function theme() {
    return lightMode
      ? {
          surface: "#F6F9F7",
          surfaceRaised: "#FFFFFF",
          ink: "#0A2A20",
          inkSoft: "rgba(10,42,32,.65)",
          inkFaint: "rgba(10,42,32,.35)",
          line: "rgba(4,57,39,.10)",
          lineSoft: "rgba(4,57,39,.06)",
          fill: "rgba(4,57,39,.05)",
          chipFill: "rgba(4,57,39,.06)",
          chipLine: "rgba(4,57,39,.14)",
          quickFill: "rgba(0,152,125,.15)",
          quickLine: "rgba(0,152,125,.45)",
          accent: "#00987D",
          hot: "#00987D",
          zero: "rgba(10,42,32,.35)",
          warnFill: "rgba(214,75,109,.10)",
          warnLine: "rgba(214,75,109,.35)",
          warnInk: "#8A2A44",
          headBg: "#FFFFFF",
          tableHeadBg: "#E3EFE9",
          shadow: "0 24px 60px rgba(4,57,39,.25)",
        }
      : {
          surface: "#043927",
          surfaceRaised: "#043927",
          ink: "#EFFFFB",
          inkSoft: "rgba(239,255,251,.75)",
          inkFaint: "rgba(239,255,251,.4)",
          line: "rgba(239,255,251,.16)",
          lineSoft: "rgba(239,255,251,.08)",
          fill: "rgba(239,255,251,.06)",
          chipFill: "rgba(239,255,251,.08)",
          chipLine: "rgba(239,255,251,.12)",
          quickFill: "rgba(0,152,125,.25)",
          quickLine: "rgba(0,152,125,.5)",
          accent: "#00987D",
          hot: "#7CE3C3",
          zero: "rgba(239,255,251,.4)",
          warnFill: "rgba(214,75,109,.18)",
          warnLine: "rgba(214,75,109,.35)",
          warnInk: "#ffd9e2",
          headBg: "#043927",
          tableHeadBg: "#062d1e",
          shadow: "0 24px 60px rgba(0,0,0,.45)",
        };
  }

  const CORNER_CSS = () => {
    const t = theme();
    return [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483000",
      "width:min(780px,94vw)",
      "max-height:74vh",
      "overflow:auto",
      `background:${t.surface}`,
      `color:${t.ink}`,
      'font:13px/1.45 "Segoe UI",system-ui,sans-serif',
      `border:1px solid ${t.line}`,
      "border-radius:16px",
      `box-shadow:${t.shadow}`,
      "padding:0",
      "margin:0",
    ].join(";");
  };
  const FULL_CSS = () => {
    const t = theme();
    return [
      "position:fixed",
      "left:0",
      "top:0",
      "right:0",
      "bottom:0",
      "z-index:2147483000",
      "width:100vw",
      "max-height:100vh",
      "overflow:auto",
      `background:${t.surface}`,
      `color:${t.ink}`,
      'font:15px/1.5 "Segoe UI",system-ui,sans-serif',
      "border:0",
      "border-radius:0",
      "box-shadow:none",
      "padding:0",
      "margin:0",
    ].join(";");
  };

  function applyMode() {
    root.style.cssText = fullscreen ? FULL_CSS() : CORNER_CSS();
  }

  document.addEventListener("keydown", (event) => {
    if (fullscreen && event.key === "Escape") {
      fullscreen = false;
      localStorage.setItem(MODE_STORAGE_KEY, "corner");
      applyMode();
      render(currentPayload);
    }
  });

  const root = document.createElement("div");
  root.id = PANEL_ID;
  applyMode();
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
    const t = theme();
    const button = mk(
      "button",
      [
        `border:1px solid ${t.line}`,
        "border-radius:10px",
        "padding:7px 12px",
        'font:700 12px/1 "Segoe UI",system-ui,sans-serif',
        `color:${t.ink}`,
        `background:${t.fill}`,
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

  function getDisplayDateFromIso(isoDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
    if (!match) {
      throw new Error("Invalid date format");
    }
    return `${match[3]}.${match[2]}.${match[1]}`;
  }

  function extractPdfName(html = "") {
    const hrefMatch = html.match(/href="[^"]*?([^\/">]+\.pdf)(?:\?[^"]*)?"/i);
    if (hrefMatch) {
      return stripTags(hrefMatch[1]);
    }

    const textMatch = stripTags(html).match(/([^\s]+\.pdf)\b/i);
    if (textMatch) {
      return stripTags(textMatch[1]);
    }

    return null;
  }

  function parseLastBetAge(rowHtml = "") {
    const normalized = stripTags(rowHtml);
    const hoursMatch = normalized.match(/\b(\d+(?:[.,]\d+)?)\s*h(?:ours?)?\s*(?:ago)?\b/i);
    if (hoursMatch) {
      return { text: `${hoursMatch[1].replace(",", ".")}h ago`, hours: Number(hoursMatch[1].replace(",", ".")) };
    }

    const secondsMatch = normalized.match(/\b(\d+(?:[.,]\d+)?)\s*(?:sec(?:onds?)?|s)\s*(?:ago)?\b/i);
    if (secondsMatch) {
      const seconds = Number(secondsMatch[1].replace(",", "."));
      return { text: `${secondsMatch[1]} seconds ago`, hours: seconds / 3600 };
    }

    const minutesMatch = normalized.match(/\b(\d+(?:[.,]\d+)?)\s*(?:min(?:utes?)?|m)\s*(?:ago)?\b/i);
    if (minutesMatch) {
      const minutes = Number(minutesMatch[1].replace(",", "."));
      return { text: `${minutesMatch[1]} minutes ago`, hours: minutes / 60 };
    }

    const hourWordMatch = normalized.match(/\b(?:an?\s+)?hour\s+ago\b/i);
    if (hourWordMatch) {
      return { text: "1h ago", hours: 1 };
    }

    return { text: null, hours: null };
  }

  function extractWinnerReportRows(html) {
    const historicalSplit = html.split(/>\s*Historical\s*</i);
    const activeHtml = historicalSplit[0] || html;
    const historicalHtml = historicalSplit.slice(1).join("Historical");
    const extractCandidateTables = (sourceHtml) =>
      [...sourceHtml.matchAll(/<table[^>]*class="[^"]*datalist[^"]*"[^>]*>([\s\S]*?)<\/table>/gi)]
        .map((match) => match[1])
        .filter((fragment) => {
          const normalized = stripTags(fragment);
          const looksLikeTopTable =
            /\bBrand\b/i.test(normalized) ||
            /\bPlayer ID\b/i.test(normalized) ||
            /\bTH\b/i.test(normalized) ||
            /\bComment\b/i.test(normalized) ||
            /\bCreate report\b/i.test(normalized);
          const looksLikeQuickTable = /\bCompany code\b/i.test(normalized) && /\bActions\b/i.test(normalized);
          return looksLikeTopTable && !looksLikeQuickTable;
        });

    const activeCandidateTables = extractCandidateTables(activeHtml);
    const historicalCandidateTables = historicalHtml ? extractCandidateTables(historicalHtml) : [];

    if (!activeCandidateTables.length && !historicalCandidateTables.length) {
      return { rows: [], activeRows: [], historicalRows: [], confidence: "low" };
    }

    const parseRows = (tableHtml) => {
      const headerMatch = tableHtml.match(/<tr[^>]*>\s*([\s\S]*?)<\/tr>/i);
      const headerCells = headerMatch
        ? [...headerMatch[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cellMatch) => stripTags(cellMatch[1]).trim())
        : [];
      const findHeaderIndex = (patterns) => headerCells.findIndex((label) => patterns.some((pattern) => pattern.test(label)));
      const netWinningsIndex = findHeaderIndex([/\bNet\s*winnings\b/i]);
      const aggregatedIndex = findHeaderIndex([/\bAggregated\b/i, /\bwin\/loss\b/i]);

      return [...tableHtml.matchAll(/<tr[^>]*class="[^"]*\blist\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => {
        const rowHtml = match[1];
        const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cellMatch) => cellMatch[1]);
        const brand = cells.length ? stripTags(cells[0]).trim() : null;
        const playerIdMatch = rowHtml.match(/<a[^>]*>([^<]+)<\/a>/i);
        const pdfName = extractPdfName(rowHtml);
        const lastBet = parseLastBetAge(rowHtml);
        const netWinningsText = netWinningsIndex >= 0 && netWinningsIndex < cells.length ? stripTags(cells[netWinningsIndex]).trim() : null;
        const aggregatedText = aggregatedIndex >= 0 && aggregatedIndex < cells.length ? stripTags(cells[aggregatedIndex]).trim() : null;

        return {
          hasPdf: Boolean(pdfName),
          brand,
          playerId: playerIdMatch ? stripTags(playerIdMatch[1]) : null,
          pdfName,
          lastBetText: lastBet.text,
          lastBetHours: lastBet.hours,
          netWinningsText,
          aggregatedText,
        };
      });
    };

    const activeRows = activeCandidateTables.flatMap((tableHtml) => parseRows(tableHtml)).filter((row) => row.playerId);
    const historicalRows = historicalCandidateTables.flatMap((tableHtml) => parseRows(tableHtml)).filter((row) => row.playerId);

    return {
      rows: [...activeRows, ...historicalRows],
      activeRows,
      historicalRows,
      confidence: activeRows.length || historicalRows.length ? "row-pdf-check" : "low",
    };
  }

  function parseWinnerReportsHtml(html) {
    const extracted = extractWinnerReportRows(html);
    const activeRows = extracted.activeRows || [];
    const historicalRows = extracted.historicalRows || [];
    if (!activeRows.length && !historicalRows.length) {
      return { pending: null, completed: null, total: null, confidence: extracted.confidence };
    }

    const pending = activeRows.reduce((sum, row) => sum + (row.hasPdf ? 0 : 1), 0);
    const completed = activeRows.reduce((sum, row) => sum + (row.hasPdf ? 1 : 0), 0);

    return { pending, completed, total: pending + completed, confidence: extracted.confidence };
  }

  function detectWinnerLoadingState(html) {
    const hasLoadingBanner =
      /Wait,\s*checking aggregation data\. The list will be updated shortly\./i.test(html) ||
      /Looking for Top players\s*-\s*part\s*\d+\/\d+/i.test(html) ||
      /loading player info\s*\d+\/\d+/i.test(html) ||
      />\s*preparation\s*</i.test(html) ||
      />\s*aggregating results\s*</i.test(html);
    return { hasLoadingBanner, stillLoading: hasLoadingBanner };
  }

  function buildWinnerRowsSignature(html) {
    return extractWinnerReportRows(html)
      .rows.map((row) => `${String(row.playerId || "").trim()}::${row.hasPdf ? "pdf" : "pending"}`)
      .sort()
      .join("|");
  }

  function extractQuickReportRows(html) {
    const tableMatches = [...html.matchAll(/<table[^>]*class="[^"]*datalist[^"]*"[^>]*>([\s\S]*?)<\/table>/gi)]
      .map((match) => match[1])
      .filter((fragment) => /User ID|Company code|Turnover|Netwin|Margin|Last bet|Actions/i.test(fragment));

    if (!tableMatches.length) {
      return { activeRows: [], historicalRows: [], confidence: "low" };
    }

    const parseRows = (tableHtml, section) =>
      [...tableHtml.matchAll(/<tr[^>]*class="[^"]*\blist\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => {
        const rowHtml = match[1];
        const playerIdMatch = rowHtml.match(/<a[^>]*>([^<]+)<\/a>/i);
        const pdfName = extractPdfName(rowHtml);
        const lastBet = parseLastBetAge(rowHtml);
        const hasGenerate =
          /value\s*=\s*["']Generate["']/i.test(rowHtml) ||
          /<input[^>]+type\s*=\s*["']button["'][^>]+Generate/i.test(rowHtml) ||
          />\s*Generate\s*</i.test(rowHtml) ||
          /\bGenerate\b/i.test(stripTags(rowHtml));

        return {
          section,
          playerId: playerIdMatch ? stripTags(playerIdMatch[1]) : null,
          hasPdf: Boolean(pdfName),
          pdfName,
          hasGenerate,
          lastBetText: lastBet.text,
          lastBetHours: lastBet.hours,
        };
      });

    const activeRows = parseRows(tableMatches[0], "active").filter((row) => row.playerId);
    const historicalRows = tableMatches.slice(1).flatMap((tableHtml) => parseRows(tableHtml, "historical")).filter((row) => row.playerId);

    return {
      activeRows,
      historicalRows,
      confidence: activeRows.length || historicalRows.length ? "quick-row-check" : "low",
    };
  }

  function parseQuickReportsHtml(html) {
    const extracted = extractQuickReportRows(html);
    const pendingRows = [
      ...extracted.activeRows.filter((row) => row.hasGenerate),
      ...extracted.historicalRows.filter((row) => !row.hasPdf),
    ];
    const completedRows = extracted.historicalRows.filter((row) => row.hasPdf);

    return {
      pending: pendingRows.length,
      completed: completedRows.length,
      total: pendingRows.length + completedRows.length,
      confidence: extracted.confidence,
      pendingRows,
      completedRows,
    };
  }

  function applyResolvedAggValues(extracted, resolvedAggByPlayerId) {
    if (!extracted || !resolvedAggByPlayerId?.size) {
      return extracted;
    }

    const patchRow = (row) => {
      if (!row?.playerId) {
        return;
      }
      const resolvedAgg = resolvedAggByPlayerId.get(row.playerId);
      if (!resolvedAgg) {
        return;
      }
      const currentAgg = String(row.aggregatedText || "").trim();
      if (currentAgg && !/^(checking\s*data|data|[-–—])$/i.test(currentAgg)) {
        return;
      }
      row.aggregatedText = resolvedAgg;
    };

    (extracted.activeRows || []).forEach(patchRow);
    (extracted.historicalRows || []).forEach(patchRow);
    (extracted.rows || []).forEach(patchRow);
    return extracted;
  }

  function removeExcludedRowsFromHtml(html, excludedPlayerIds) {
    if (!excludedPlayerIds.size) {
      return html;
    }

    return html.replace(/<tr[^>]*class="[^"]*\blist\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi, (fullMatch, rowHtml) => {
      const playerIdMatch = rowHtml.match(/<a[^>]*>([^<]+)<\/a>/i);
      const playerId = playerIdMatch ? stripTags(playerIdMatch[1]) : null;
      return playerId && excludedPlayerIds.has(playerId) ? "" : fullMatch;
    });
  }

  function normalizeMailerTabLabel(value = "") {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function parseMailerTabsFromHtml(html = "") {
    return [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((match) => {
        const inner = match[1] || "";
        const badgeHtmlMatch = inner.match(/<i[^>]*>([\s\S]*?)<\/i>/i);
        const badgeText = badgeHtmlMatch ? stripTags(badgeHtmlMatch[1]) : "";
        const badgeCountMatch = badgeText.match(/(\d+)/);
        const labelHtml = inner.replace(/<i[^>]*>[\s\S]*?<\/i>/gi, "");
        const label = stripTags(labelHtml);
        const normalized = normalizeMailerTabLabel(label);

        if (!MAILING_TAB_LABELS.has(normalized)) {
          return null;
        }

        return {
          type: normalized.replace(/\s+/g, "-"),
          label,
          count: badgeCountMatch ? Number(badgeCountMatch[1]) : 0,
        };
      })
      .filter(Boolean);
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

  async function waitForWinnerPageToSettle(displayDate, clientName = "") {
    const strictClient = QUICK_REPORT_LATE_CLIENTS.has(String(clientName || ""));
    const timingProfile = strictClient
      ? { waitMs: WINNER_WAIT_MS, confirmWaitMs: WINNER_CONFIRM_WAIT_MS, maxPollingAttempts: WINNER_MAX_POLLING_ATTEMPTS }
      : { waitMs: WINNER_WAIT_MS, confirmWaitMs: WINNER_CONFIRM_WAIT_MS };
    let lastText = "";
    let lastSettledText = "";
    const startedAt = Date.now();
    let attempts = 0;

    while (strictClient ? attempts < timingProfile.maxPollingAttempts : Date.now() - startedAt <= WINNER_MAX_LOADING_MS) {
      attempts += 1;
      const text = await boFetch(`/ajax.php?q=lfs/top/custom&date=${encodeURIComponent(displayDate)}`);
      lastText = text;
      const { hasLoadingBanner, stillLoading } = detectWinnerLoadingState(text);
      const hasVisibleRows = extractWinnerReportRows(text).rows.length > 0;

      if (stillLoading && !hasVisibleRows) {
        await sleep(timingProfile.waitMs);
        continue;
      }

      lastSettledText = text;

      if (strictClient) {
        const firstSignature = buildWinnerRowsSignature(text);
        await sleep(timingProfile.confirmWaitMs);

        const secondSettled = await boFetch(`/ajax.php?q=lfs/top/custom&date=${encodeURIComponent(displayDate)}`);
        const secondState = detectWinnerLoadingState(secondSettled);
        const secondHasVisibleRows = extractWinnerReportRows(secondSettled).rows.length > 0;
        if (secondState.stillLoading && !secondHasVisibleRows) {
          await sleep(timingProfile.waitMs);
          continue;
        }

        if (firstSignature !== buildWinnerRowsSignature(secondSettled)) {
          lastSettledText = secondSettled;
          await sleep(timingProfile.confirmWaitMs);
          continue;
        }

        return { html: secondSettled, confirmed: true };
      }

      return { html: text, confirmed: true };
    }

    return { html: lastSettledText || lastText, confirmed: false };
  }

  async function resolveWinnerAggIdCandidates(displayDate, clientName, baseHtml) {
    const extracted = extractWinnerReportRows(baseHtml);
    const candidates = [...extracted.activeRows, ...extracted.historicalRows].filter(
      (row) => row.playerId && row.playerId.includes(":"),
    );

    if (!candidates.length) {
      return { excludedPlayerIds: new Set(), resolvedAggByPlayerId: new Map() };
    }

    const excludedPlayerIds = new Set();
    const resolvedAggByPlayerId = new Map();
    let cursor = 0;

    async function worker() {
      while (cursor < candidates.length) {
        const row = candidates[cursor++];
        const separatorIndex = row.playerId.indexOf(":");
        if (separatorIndex === -1) {
          continue;
        }

        const brand = (row.brand || row.playerId.slice(0, separatorIndex)).trim().split(":").join("~");
        const playerIdWithTilde = row.playerId.split(":").join("~");
        const aggID = `${brand}:${playerIdWithTilde}`;
        const url = `/ajax.php?q=lfs/top/custom&date=${encodeURIComponent(displayDate)}&th=${WINNER_AGG_THRESHOLD}&aggID=${encodeURIComponent(aggID)}`;

        try {
          const text = await boFetch(url);
          const excluded = /topCustomLineToHide/i.test(text);
          const valueMatch = text.match(/^\s*(-?[\d,]+\.\d+)/);
          if (excluded) {
            excludedPlayerIds.add(row.playerId);
          } else if (valueMatch) {
            resolvedAggByPlayerId.set(row.playerId, valueMatch[1]);
          }
        } catch {
          // keep row on resolution failure, same as the server build
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(WINNER_AGG_CONCURRENCY, candidates.length) }, worker));

    return { excludedPlayerIds, resolvedAggByPlayerId };
  }

  async function fetchWinnerReportsHtml(displayDate, clientName = "") {
    const strictClient = QUICK_REPORT_LATE_CLIENTS.has(String(clientName || ""));
    const result = await waitForWinnerPageToSettle(displayDate, clientName);

    if (!strictClient) {
      return { html: result.html, resolvedAggByPlayerId: new Map(), confirmed: result.confirmed };
    }

    const { excludedPlayerIds, resolvedAggByPlayerId } = await resolveWinnerAggIdCandidates(
      displayDate,
      clientName,
      result.html,
    );

    return {
      html: removeExcludedRowsFromHtml(result.html, excludedPlayerIds),
      resolvedAggByPlayerId,
      confirmed: result.confirmed,
    };
  }

  async function fetchQuickReportsHtml(isoDate, clientName = "") {
    let lastText = "";
    let previousSignature = "";
    let stablePasses = 0;

    for (let attempt = 1; attempt <= LATE_TAB_MAX_ATTEMPTS; attempt += 1) {
      const quickPath =
        attempt === 1
          ? `/ajax.php?q=lfs/toCheck/list_quickReports&type=quickReports&uid=&selectFrom=${encodeURIComponent(isoDate)}&selectTo=${encodeURIComponent(isoDate)}&regen=1`
          : `/ajax.php?q=lfs/toCheck/list_quickReports&type=quickReports&uid=&selectFrom=${encodeURIComponent(isoDate)}&selectTo=${encodeURIComponent(isoDate)}`;

      const text = await boFetch(quickPath);
      lastText = text;
      const parsed = parseQuickReportsHtml(text);
      const signature = `${parsed.pending}:${parsed.completed}:${parsed.total}`;

      if (signature === previousSignature) {
        stablePasses += 1;
      } else {
        previousSignature = signature;
        stablePasses = 0;
      }

      if (!QUICK_REPORT_LATE_CLIENTS.has(String(clientName || ""))) {
        return text;
      }

      if (parsed.total > 0 && stablePasses >= 1) {
        return text;
      }

      if (attempt < LATE_TAB_MAX_ATTEMPTS) {
        await sleep(LATE_TAB_WAIT_MS);
      }
    }

    return lastText;
  }

  function buildClientWinnerOverview(clientRef, isoDate, quickData, winnerPayload, winnerData, extracted) {
    const clientQueueItems = [];
    const completedQueueItems = [];

    const pushQueueItem = (row, reportType) => {
      const playerId = String(row?.playerId || "").trim();
      if (!playerId) {
        return;
      }
      clientQueueItems.push({
        clientId: clientRef.id,
        client: clientRef.client,
        playerId,
        reportType,
        lastBetText: row.lastBetText,
        lastBetHours: row.lastBetHours,
        netWinningsText: row.netWinningsText || null,
        aggregatedText: row.aggregatedText || null,
        overdue: typeof row.lastBetHours === "number" ? row.lastBetHours >= 3 : false,
      });
    };

    (quickData.pendingRows || []).forEach((row) => pushQueueItem(row, "quick"));
    (extracted.activeRows || []).filter((row) => !row.hasPdf).forEach((row) => pushQueueItem(row, "winner"));

    const snapshotConfirmed = !QUICK_REPORT_LATE_CLIENTS.has(clientRef.client) || winnerPayload.confirmed;
    const doneRows = snapshotConfirmed ? (extracted.activeRows || []).filter((row) => row.hasPdf) : [];

    const pushCompletedItem = (row, reportType) => {
      const playerId = String(row?.playerId || "").trim();
      if (!playerId) {
        return;
      }
      completedQueueItems.push({
        clientId: clientRef.id,
        client: clientRef.client,
        playerId,
        reportType,
        pdfName: row.pdfName || null,
        lastBetText: row.lastBetText,
        lastBetHours: row.lastBetHours,
        netWinningsText: row.netWinningsText || null,
        aggregatedText: row.aggregatedText || null,
      });
    };

    (quickData.completedRows || []).forEach((row) => pushCompletedItem(row, "quick"));
    doneRows.forEach((row) => pushCompletedItem(row, "winner"));

    const quickPendingCount = clientQueueItems.filter((item) => item.reportType === "quick").length;
    const winnerPendingOnly = clientQueueItems.filter((item) => item.reportType === "winner").length;

    return {
      winnerCounts: {
        quickReports: quickPendingCount,
        quickReportsCompleted: quickData.completed,
        quickReportsTotal: quickData.total,
        quickReportsConfidence: quickData.confidence,
        winnerReports: winnerPendingOnly,
        winnerReportsCompleted: snapshotConfirmed ? winnerData.completed : null,
        winnerReportsTotal: snapshotConfirmed ? winnerData.total : null,
        winnerReportsConfidence: snapshotConfirmed ? winnerData.confidence : "pending-confirmation",
      },
      reportQueueItems: clientQueueItems,
      completedQueueItems,
    };
  }

  async function collectWinnerForClient(clientRef, isoDate, displayDate) {
    const isLateClient = QUICK_REPORT_LATE_CLIENTS.has(clientRef.client);

    let quickData = { pending: 0, completed: 0, total: 0, confidence: "skipped", pendingRows: [], completedRows: [] };
    if (isLateClient) {
      const quickHtml = await fetchQuickReportsHtml(isoDate, clientRef.client);
      quickData = parseQuickReportsHtml(quickHtml);
    }

    const winnerPayload = await fetchWinnerReportsHtml(displayDate, clientRef.client);
    const winnerData = parseWinnerReportsHtml(winnerPayload.html);
    const extracted = applyResolvedAggValues(
      extractWinnerReportRows(winnerPayload.html),
      winnerPayload.resolvedAggByPlayerId,
    );

    return buildClientWinnerOverview(clientRef, isoDate, quickData, winnerPayload, winnerData, extracted);
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
    const t = theme();
    statsGrid.appendChild(
      mk(
        "div",
        `background:${t.fill};border:1px solid ${t.lineSoft};border-radius:12px;padding:10px 12px;display:grid;gap:2px;`,
        `<strong style="font-size:${fullscreen ? 26 : 18}px;">${escapeHtml(value)}</strong><span style="font-size:${fullscreen ? 13 : 11}px;color:${t.inkSoft};">${escapeHtml(label)}</span>`,
      ),
    );
  }

  function addChip(cell, label, count, isQuick) {
    const t = theme();
    cell.appendChild(
      mk(
        "span",
        [
          `display:inline-block;margin:2px 4px 2px 0;padding:${fullscreen ? "5px 12px" : "3px 8px"};border-radius:999px;font-size:${fullscreen ? 12.5 : 11}px;`,
          isQuick
            ? `background:${t.quickFill};border:1px solid ${t.quickLine};`
            : `background:${t.chipFill};border:1px solid ${t.chipLine};`,
        ].join(""),
        `${escapeHtml(label)} ${escapeHtml(count)}`,
      ),
    );
  }

  function render(payload, extra = {}) {
    const t = theme();
    const data = payload ? applyNightOnlyFilter(payload) : null;
    const clients = data?.clients || [];
    const uncheckedCases = clients.reduce((sum, client) => sum + client.total, 0);
    const clientsWithBacklog = clients.filter((client) => client.total > 0).length;
    const largest = [...clients].sort((a, b) => b.total - a.total)[0] || null;
    const winnerLeft = clients.reduce((sum, client) => sum + (Number(client.winnerReports) || 0), 0);
    const minimized = root.dataset.minimized === "1";

    root.innerHTML = "";

    const head = mk(
      "div",
      `display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid ${t.line};position:sticky;top:0;background:${t.headBg};z-index:2;`,
    );
    head.appendChild(
      mk(
        "div",
        `font-weight:800;letter-spacing:-.01em;color:${t.ink};`,
        `BO Checklist <span style="color:${t.accent};font-size:11px;margin-left:6px;font-weight:700;">${escapeHtml(VERSION)}</span>`,
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
      mkBtn(fullscreen ? "Exit full screen" : "Full screen", () => {
        fullscreen = !fullscreen;
        localStorage.setItem(MODE_STORAGE_KEY, fullscreen ? "full" : "corner");
        applyMode();
        render(currentPayload);
      }),
    );
    tools.appendChild(
      mkBtn(lightMode ? "Dark mode" : "Light mode", () => {
        lightMode = !lightMode;
        localStorage.setItem(THEME_STORAGE_KEY, lightMode ? "light" : "dark");
        applyMode();
        render(currentPayload);
      }),
    );
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
        `padding:10px 14px;color:${t.inkSoft};border-bottom:1px solid ${t.lineSoft};`,
        `${escapeHtml(extra.progressLine || statusLine)} · Updated ${escapeHtml(formatStamp(data?.snapshotDate))}`,
      ),
    );

    if (minimized) {
      return;
    }

    const statsGrid = mk(
      "div",
      `display:grid;grid-template-columns:repeat(${fullscreen ? 5 : 4},1fr);gap:${fullscreen ? 10 : 8}px;padding:${fullscreen ? "20px 24px" : "12px 14px"};`,
    );
    addStat(statsGrid, uncheckedCases, "Unchecked total");
    addStat(statsGrid, clientsWithBacklog, "Clients with work");
    if (fullscreen) {
      addStat(statsGrid, largest?.client || "—", "Largest backlog");
    }
    addStat(statsGrid, winnerLeft, "Winner reports left");
    addStat(statsGrid, data?.ticketing?.requests ?? "—", "Ticketing requests");
    root.appendChild(statsGrid);

    if (data?.warnings?.length) {
      data.warnings.forEach((line) => {
        root.appendChild(
          mk(
            "div",
            `margin:0 14px 10px;padding:10px 12px;border-radius:10px;background:${t.warnFill};border:1px solid ${t.warnLine};color:${t.warnInk};`,
            escapeHtml(line),
          ),
        );
      });
    }

    const tableWrap = mk("div", `padding:${fullscreen ? "0 24px 24px" : "0 14px 14px"};overflow:auto;`);
    const table = mk(
      "table",
      `width:100%;border-collapse:collapse;font-size:${fullscreen ? 15 : 12.5}px;table-layout:${fullscreen ? "fixed" : "auto"};`,
    );
    const thead = mk("thead");
    const headRow = mk("tr");
    ["Client", "Total", "Winner", "Non-zero tabs"].forEach((title, columnIndex) => {
      headRow.appendChild(
        mk(
          "th",
          [
            `text-align:left;padding:${fullscreen ? "12px 14px" : "8px 10px"};border-bottom:1px solid ${t.lineSoft};font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:${t.inkSoft};background:${t.tableHeadBg};`,
            fullscreen ? `width:${["18%", "7%", "7%", "68%"][columnIndex]};` : "",
          ].join(""),
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
          `text-align:center;color:${t.inkFaint};padding:18px;`,
          "No data yet. Press Scan.",
        ),
      );
      emptyRow.firstChild.colSpan = 4;
      tbody.appendChild(emptyRow);
    }
    clients.forEach((client) => {
      const row = mk("tr");
      const cellCss = `text-align:left;padding:${fullscreen ? "12px 14px" : "8px 10px"};border-bottom:1px solid ${t.lineSoft};vertical-align:top;`;
      row.appendChild(mk("td", cellCss, escapeHtml(client.client)));
      row.appendChild(
        mk(
          "td",
          `${cellCss}font-weight:800;color:${client.total > 0 ? t.hot : t.zero};`,
          escapeHtml(client.total),
        ),
      );
      row.appendChild(
        mk(
          "td",
          `${cellCss}font-weight:${Number.isInteger(client.winnerReports) ? 700 : 400};color:${client.winnerReports > 0 ? t.hot : t.zero};`,
          escapeHtml(client.winnerReports ?? "—"),
        ),
      );
      const tabsCell = mk("td", cellCss);
      (client.nonZero || []).forEach((item) => {
        addChip(tabsCell, item.label, item.count, item.type === "quickReports");
      });
      row.appendChild(tabsCell);
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    root.appendChild(tableWrap);

    const reportQueue = (data?.reportQueue || []).filter((item) => !isQuickReport(item));
    const quickQueue = (data?.reportQueue || []).filter(isQuickReport);
    const completedQueue = data?.completedQueue || [];

    if (reportQueue.length || quickQueue.length || completedQueue.length) {
      const queuesWrap = mk(
        "div",
        fullscreen
          ? "display:flex;gap:12px;padding:0 24px 24px;align-items:flex-start;"
          : "padding:0 14px 14px;",
      );

      const buildQueueCard = (titleText, items, isCompleted) => {
        const card = mk(
          "div",
          `flex:1;min-width:0;background:${t.fill};border:1px solid ${t.lineSoft};border-radius:12px;padding:12px;`,
        );
        card.appendChild(
          mk(
            "div",
            `font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:${t.inkSoft};margin-bottom:8px;`,
            `${escapeHtml(titleText)} · ${escapeHtml(items.length)}`,
          ),
        );

        if (!items.length) {
          card.appendChild(
            mk("div", `color:${t.inkFaint};padding:8px 0;`, isCompleted ? "No completed reports yet." : "Queue is empty."),
          );
        }

        items.slice(0, fullscreen ? 40 : 12).forEach((item) => {
          const line = mk(
            "div",
            `display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-radius:8px;margin-bottom:4px;background:${t.surfaceRaised};border:1px solid ${t.chipLine};font-size:12px;`,
          );
          line.appendChild(
            mk(
              "div",
              "display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;",
              `<span style="background:${t.chipFill};border:1px solid ${t.chipLine};display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;">${escapeHtml(item.client)}</span>` +
                `<span style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.playerId)}</span>` +
                (item.overdue && !isCompleted ? `<span style="color:${t.warnInk};font-size:10px;font-weight:700;">overdue</span>` : ""),
            ),
          );
          line.appendChild(
            mk(
              "div",
              `color:${t.inkSoft};font-size:11px;white-space:nowrap;`,
              escapeHtml(
                isCompleted
                  ? item.pdfName || "PDF ready"
                  : trimDetail(item.lastBetText, item.netWinningsText, item.aggregatedText),
              ),
            ),
          );
          card.appendChild(line);
        });

        return card;
      };

      queuesWrap.appendChild(buildQueueCard("Winner report queue", reportQueue, false));
      queuesWrap.appendChild(buildQueueCard("Quick report queue", quickQueue, false));
      queuesWrap.appendChild(buildQueueCard("Completed reports", completedQueue, true));

      root.appendChild(queuesWrap);
    }

    const mailing = data?.mailing || [];
    if (mailing.length) {
      const mailingCard = mk(
        "div",
        fullscreen
          ? `margin:0 24px 24px;background:${t.fill};border:1px solid ${t.lineSoft};border-radius:12px;padding:12px;`
          : `margin:0 14px 14px;background:${t.fill};border:1px solid ${t.lineSoft};border-radius:12px;padding:12px;`,
      );
      mailingCard.appendChild(
        mk(
          "div",
          `font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:${t.inkSoft};margin-bottom:8px;`,
          `Mailing check · ${escapeHtml(mailing.length)}`,
        ),
      );
      mailing.forEach((row) => {
        const line = mk(
          "div",
          `display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;border-radius:8px;margin-bottom:4px;background:${t.surfaceRaised};border:1px solid ${t.chipLine};font-size:12px;`,
        );
        line.appendChild(
          mk(
            "span",
            `display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;background:${t.chipFill};border:1px solid ${t.chipLine};`,
            escapeHtml(row.client),
          ),
        );
        row.tabs.forEach((tab) => {
          line.appendChild(
            mk(
              "span",
              `display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;background:${t.quickFill};border:1px solid ${t.quickLine};`,
              `${escapeHtml(tab.label)} ${escapeHtml(tab.count)}`,
            ),
          );
        });
        mailingCard.appendChild(line);
      });
      root.appendChild(mailingCard);
    }
  }

  function isQuickReport(item) {
    return item?.reportType === "quick";
  }

  function trimDetail(lastBetText, netWinningsText, aggregatedText) {
    return [lastBetText, netWinningsText, aggregatedText].filter(Boolean).join(" · ").slice(0, 60) || "—";
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

      const displayDate = getDisplayDateFromIso(isoDate);
      const results = [];
      const reportQueue = [];
      const completedQueue = [];
      const mailingRows = [];

      for (let index = 0; index < clients.length; index += 1) {
        const clientRef = clients[index];
        statusLine = `Scanning ${index + 1} / ${clients.length}`;
        render(currentPayload, { progressLine: `${statusLine} — ${clientRef.client}` });

        await boFetch(`/ajax.php?q=core/userTeamSelect&type=lfs&val=${encodeURIComponent(clientRef.id)}`);
        const toCheckHtml = await fetchToCheckHtmlWithLateTabs(isoDate, clientRef.client);
        const overview = collectClient(clientRef, toCheckHtml);

        let winnerCounts = {
          quickReports: null,
          quickReportsCompleted: null,
          quickReportsTotal: null,
          quickReportsConfidence: "error",
          winnerReports: null,
          winnerReportsCompleted: null,
          winnerReportsTotal: null,
          winnerReportsConfidence: "error",
        };

        try {
          const winnerOverview = await collectWinnerForClient(clientRef, isoDate, displayDate);
          winnerCounts = winnerOverview.winnerCounts;
          reportQueue.push(...winnerOverview.reportQueueItems);
          completedQueue.push(...winnerOverview.completedQueueItems);
        } catch (error) {
          currentPayload = currentPayload
            ? { ...currentPayload, warnings: [...new Set([...(currentPayload.warnings || []), `${clientRef.client}: ${error.message}`])] }
            : { snapshotDate: null, ticketing: null, clients: [], warnings: [`${clientRef.client}: ${error.message}`] };
        }

        let mailing = [];
        try {
          const mailerHtml = await boFetch("/ajax.php?q=lfs/ticketing/mailer");
          mailing = parseMailerTabsFromHtml(mailerHtml).filter((tab) => tab.count > 0);
        } catch {
          mailing = [];
        }
        if (mailing.length) {
          mailingRows.push({ client: clientRef.client, clientId: clientRef.id, tabs: mailing });
        }

        results.push({ ...overview, ...winnerCounts });
        render(
          currentPayload,
          {
            progressLine: `${statusLine} — ${clientRef.client} (winner ${winnerCounts.winnerReports ?? "?"}, quick ${winnerCounts.quickReports ?? "?"})`,
          },
        );
        await sleep(SCAN_STEP_DELAY_MS);
      }

      restoreOriginalClient();

      const sorted = [...results].sort((a, b) => b.total - a.total || a.client.localeCompare(b.client));
      currentPayload = {
        snapshotDate: new Date().toISOString(),
        requestedDate: isoDate,
        ticketing: { requests: ticketingRequests },
        clients: sorted,
        reportQueue: reportQueue.sort((a, b) => (b.lastBetHours ?? -1) - (a.lastBetHours ?? -1)),
        completedQueue,
        mailing: mailingRows,
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
