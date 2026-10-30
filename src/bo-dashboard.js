/*!
 * BO Checklist Dashboard (bookmarklet build)
 * Runs inside an authenticated lfscbo.com page. No server, no extension.
 * Reuses the parsing flow of the local server build and renders the same
 * dashboard UI as the local tool, inside a shadow-root overlay.
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
  const WINNER_TIMER_FLAG = "__boChecklistWinnerTimer";
  const REFRESH_MS = 5 * 60 * 1000;
  const WINNER_REFRESH_MS = 10 * 60 * 1000;
  const LATE_TAB_WAIT_MS = 1200;
  const LATE_TAB_MAX_ATTEMPTS = 4;
  const QUICK_REPORT_LATE_CLIENTS = new Set(["Mac88", "Royal Gaming"]);
  const SCAN_STEP_DELAY_MS = 250;
  const NIGHT_ONLY_TYPES = new Set(["robotPlayers", "dealerPlayerMargin"]);
  const NIGHT_FILTER_STORAGE_KEY = "bo-checklist-ignore-night-only-v1";
  const HIDE_CLEAR_STORAGE_KEY = "bo-checklist-hide-clear-v1";
  const NOTIFICATIONS_STORAGE_KEY = "bo-request-notifications";
  const THEME_STORAGE_KEY = "bo-checklist-theme-v1";
  const COMPLETED_REPORTS_COLLAPSED_LIMIT = 5;
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
  if (window[WINNER_TIMER_FLAG]) {
    window.clearTimeout(window[WINNER_TIMER_FLAG]);
    window[WINNER_TIMER_FLAG] = null;
  }
  window[CLOSED_FLAG] = false;

  document.getElementById(PANEL_ID)?.remove();

  const VERSION = "v1";
  const DASHBOARD_CSS = __DASHBOARD_CSS_JSON__;

  let currentPayload = null;
  let isScanningStatus = false;
  let isScanningWinner = false;
  let overviewResults = [];
  let overviewSnapshotAt = null;
  let winnerClients = {};
  let winnerReportQueue = [];
  let winnerCompletedQueue = [];
  let winnerMailingRows = [];
  let winnerSnapshotAt = null;
  let ticketingData = null;
  let userConsented = false;
  let ignoreNightOnly = localStorage.getItem(NIGHT_FILTER_STORAGE_KEY) === "1";
  let hideClearClients = localStorage.getItem(HIDE_CLEAR_STORAGE_KEY) === "1";
  let originalClientId = null;
  let statusLine = "Ready. Press Scan.";
  let selectedDateIso = getIsoDate();
  let completedReportsExpanded = false;
  let requestNotificationsEnabled = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) === "1";
  let lastRequestsTotal = null;
  let minimized = false;
  let darkMode = localStorage.getItem(THEME_STORAGE_KEY) === "dark";
  const statusProgress = { inProgress: false, processedClients: 0, totalClients: 0, currentClient: null, currentStage: null };
  const winnerProgress = { inProgress: false, processedClients: 0, totalClients: 0, currentClient: null, currentStage: null };
  const refreshingClientIds = new Set();

  const host = document.createElement("div");
  host.id = PANEL_ID;
  const LIGHT_BG = "radial-gradient(circle at top left, rgba(10,163,108,.12), transparent 25%), radial-gradient(circle at top right, rgba(106,70,242,.16), transparent 28%), linear-gradient(180deg,#fbf7f0 0%, #f6f1e8 55%, #ece2cf 100%)";
  const DARK_BG = "radial-gradient(circle at top left, rgba(10,163,108,.14), transparent 25%), radial-gradient(circle at top right, rgba(106,70,242,.12), transparent 28%), linear-gradient(180deg,#02120d 0%, #000E0B 60%, #000a08 100%)";
  host.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483000",
    "overflow:auto",
    `background:${darkMode ? DARK_BG : LIGHT_BG}`,
    'font-family:"Segoe UI","Trebuchet MS",sans-serif',
    "color:#111827",
  ].join(";");
  const shadow = host.attachShadow({ mode: "open" });
  document.body.appendChild(host);

  // Self-healing: if the host page re-renders and drops the panel, put it back.
  const heartbeat = window.setInterval(() => {
    if (window[CLOSED_FLAG]) {
      window.clearInterval(heartbeat);
      return;
    }
    if (!host.isConnected) {
      document.body.appendChild(host);
    }
  }, 1500);

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

  function isQuickReport(item) {
    return item?.reportType === "quick";
  }

  function clientSupportsQuick(clientName = "") {
    return /mac88|royal\s*gaming/i.test(String(clientName));
  }

  function notifyRequests(data) {
    const count = Number.isSafeInteger(data?.ticketing?.requests) ? data.ticketing.requests : null;
    if (count === null) {
      return;
    }
    if (
      lastRequestsTotal !== null &&
      count > lastRequestsTotal &&
      requestNotificationsEnabled &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      try {
        new Notification("BO Checklist", { body: `New ticketing requests: ${count}` });
      } catch {
        // notifications are best-effort
      }
    }
    lastRequestsTotal = count;
  }

  function summariseHotspots(clients) {
    const map = new Map();
    clients.forEach((client) => {
      client.nonZero.forEach((item) => {
        const entry = map.get(item.label) || { label: item.label, count: 0, clients: [] };
        entry.count += item.count;
        entry.clients.push(client.client);
        map.set(item.label, entry);
      });
    });
    return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 6);
  }

  function formatLastUpdated(value) {
    if (!value) {
      return "No updates yet";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "Last update unknown";
    }
    return `Last update ${date.toLocaleDateString("en-GB")} ${date.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })}`;
  }

  function formatWinnerNextCheckText() {
    if (!winnerSnapshotAt) {
      return "Next auto winner check after first winner refresh";
    }
    const winnerTs = new Date(winnerSnapshotAt).getTime();
    if (!Number.isFinite(winnerTs)) {
      return "Next auto winner check unknown";
    }
    const remainingMs = Math.max(0, WINNER_REFRESH_MS - (Date.now() - winnerTs));
    if (remainingMs <= 0) {
      return "Winner auto-check due now";
    }
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours > 0) {
      parts.push(`${hours}h`);
    }
    if (minutes > 0 || hours > 0) {
      parts.push(`${minutes}m`);
    }
    parts.push(`${seconds}s`);
    return `Next auto winner check in ${parts.join(" ")}`;
  }

  function formatReportAge(lastBetHours, fallbackText = "") {
    if (typeof lastBetHours !== "number" || Number.isNaN(lastBetHours) || lastBetHours < 0) {
      const rawText = String(fallbackText || "").trim();
      if (rawText) {
        const secondsMatch = rawText.match(/(\d+(?:[.,]\d+)?)\s*(?:sec(?:onds?)?|s)/i);
        if (secondsMatch) {
          return `${Math.max(1, Math.round(Number(secondsMatch[1].replace(",", "."))))} sec ago`;
        }
        const minutesMatch = rawText.match(/(\d+(?:[.,]\d+)?)\s*(?:min(?:utes?)?|m)/i);
        if (minutesMatch) {
          return `${Math.max(1, Math.round(Number(minutesMatch[1].replace(",", "."))))} min ago`;
        }
        const hoursMatch = rawText.match(/(\d+(?:[.,]\d+)?)\s*h/i);
        if (hoursMatch) {
          const totalMinutes = Math.round(Number(hoursMatch[1].replace(",", ".")) * 60);
          if (totalMinutes < 60) {
            return `${Math.max(1, totalMinutes)} min ago`;
          }
          const hours = Math.floor(totalMinutes / 60);
          const minutes = totalMinutes % 60;
          return minutes === 0 ? `${hours}h ago` : `${hours}h ${minutes}m ago`;
        }
      }
      if (!rawText || rawText === "-" || rawText === "—") {
        return "<1 min ago";
      }
      return rawText;
    }

    const totalSeconds = Math.max(1, Math.round(lastBetHours * 60 * 60));
    if (totalSeconds < 60) {
      return `${totalSeconds} sec ago`;
    }
    const totalMinutes = Math.round(totalSeconds / 60);
    if (totalMinutes < 60) {
      return `${totalMinutes} min ago`;
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (minutes === 0) {
      return `${hours}h ago`;
    }
    return `${hours}h ${minutes}m ago`;
  }

  function getReportPriorityClass(lastBetHours, fallbackText = "") {
    if (typeof lastBetHours !== "number" || Number.isNaN(lastBetHours) || lastBetHours < 0) {
      const rawText = String(fallbackText || "").trim();
      if (!rawText || rawText === "-" || rawText === "—") {
        return "priority-fresh";
      }
      if (/^<\s*1\s*min\s*ago$/i.test(rawText)) {
        return "priority-fresh";
      }
      return "";
    }
    if (lastBetHours >= 3) {
      return "priority-3h";
    }
    if (lastBetHours >= 2) {
      return "priority-2h";
    }
    return "priority-fresh";
  }

  function getQueueClientThemeClass(clientName = "") {
    const normalized = String(clientName || "").trim().toLowerCase();
    const map = {
      "mac88": "client-theme-mac88",
      "iconic21": "client-theme-iconic21",
      "digitain": "client-theme-digitain",
      "enjoy gaming": "client-theme-enjoy-gaming",
      "amazing gaming": "client-theme-amazing-gaming",
      "ballys": "client-theme-ballys",
      "mgasia": "client-theme-mgasia",
      "royal gaming": "client-theme-royal-gaming",
      "stakelogic": "client-theme-stakelogic",
      "onetouch": "client-theme-onetouch",
      "one touch": "client-theme-onetouch",
      "animo": "client-theme-animo",
      "live vegas": "client-theme-live-vegas",
    };
    return map[normalized] || "client-theme-default";
  }

  function getQueueClientExtraClass(clientName = "") {
    return String(clientName || "").trim().toLowerCase() === "enjoy gaming" ? "two-line" : "";
  }

  function getQueueClientLabelHtml(clientName = "") {
    const raw = String(clientName || "Client").trim() || "Client";
    if (raw.toLowerCase() === "enjoy gaming") {
      return "Enjoy<br>Gaming";
    }
    return escapeHtml(raw);
  }

  function renderQueueClientPill(clientName = "") {
    const extraClass = ["queue-client-pill", getQueueClientThemeClass(clientName), getQueueClientExtraClass(clientName)]
      .filter(Boolean)
      .join(" ");
    return `<div class="${extraClass}">${getQueueClientLabelHtml(clientName)}</div>`;
  }

  function closePanel() {
    window[CLOSED_FLAG] = true;
    window.clearInterval(heartbeat);
    window.clearTimeout(window[TIMER_FLAG]);
    window[TIMER_FLAG] = null;
    window.clearTimeout(window[WINNER_TIMER_FLAG]);
    window[WINNER_TIMER_FLAG] = null;
    host.remove();
  }

  function render(payload, extra = {}) {
    if (!payload) {
      payload = mergePayload();
    }
    currentPayload = payload;
    notifyRequests(payload);

    const pendingPlayers = (payload?.reportQueue || []).length;

    if (minimized) {
      const uncheckedTotal = (payload?.clients || []).reduce((sum, client) => sum + (Number(client.total) || 0), 0);
      const pendingLabel = payload?.winnerReportsSnapshotDate ? String(pendingPlayers) : "…";
      shadow.innerHTML = `<style>${DASHBOARD_CSS}</style>
        <div class="bm-mini" id="bm-mini">
          BO Checklist<span class="bm-version">${escapeHtml(VERSION)}</span>
          <span class="bm-mini-note">Unchecked:</span><b>${escapeHtml(uncheckedTotal)}</b>
          <span class="bm-mini-note">Pending players:</span><b>${escapeHtml(pendingLabel)}</b>
          <span class="bm-mini-note">Click to open</span>
        </div>`;
      shadow.getElementById("bm-mini").addEventListener("click", () => {
        minimized = false;
        render(currentPayload);
      });
      return;
    }

    const visibleData = applyNightOnlyFilter(payload || { clients: [], warnings: [] });
    const clients = [...(visibleData.clients || [])]
      .sort((a, b) => b.total - a.total || a.client.localeCompare(b.client))
      .filter(
        (client) =>
          !hideClearClients ||
          client.total > 0 ||
          (Number(client.winnerReports) || 0) > 0,
      );
    const activeClients = clients.filter((client) => client.total > 0);
    const idleClients = clients.filter((client) => client.total === 0);
    const hotspots = summariseHotspots(activeClients);
    const largest = activeClients[0] || null;
    const totalUnchecked = clients.reduce((sum, client) => sum + client.total, 0);
    const winnerLeft = clients.reduce((sum, client) => sum + (Number(client.winnerReports) || 0), 0);
    const reportQueue = [...(visibleData.reportQueue || [])];
    const winnerQueue = reportQueue.filter((item) => item.reportType === "winner");
    const quickQueue = reportQueue.filter((item) => item.reportType === "quick");
    const completedQueue = [...(visibleData.completedQueue || [])];
    const visibleCompletedQueue = completedReportsExpanded
      ? completedQueue
      : completedQueue.slice(0, COMPLETED_REPORTS_COLLAPSED_LIMIT);
    const mailingClients = [...(visibleData.mailing || [])]
      .map((row) => ({ ...row, total: (row.tabs || []).reduce((sum, tab) => sum + (Number(tab.count) || 0), 0) }))
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total || String(a.client || "").localeCompare(String(b.client || "")));
    const mailingTotal = mailingClients.reduce((sum, row) => sum + row.total, 0);
    const requestsTotal = Number.isSafeInteger(payload?.ticketing?.requests) ? payload.ticketing.requests : null;
    const requestsLabel = requestsTotal === null ? "Unknown - waiting for Ticketing badge" : String(requestsTotal);
    const snapshotLabel = selectedDateIso || "";
    const maxTotal = Math.max(...clients.map((client) => client.total), 1);

    const lastUpdatedText = isScanningStatus
      ? statusProgress.currentClient
        ? `Overview ${statusProgress.processedClients}/${statusProgress.totalClients || "?"}: ${statusProgress.currentClient}`
        : `Loading clients ${statusProgress.processedClients}/${statusProgress.totalClients || "?"}`
      : formatLastUpdated(payload?.snapshotDate);
    const winnerChipText = isScanningWinner
      ? winnerProgress.currentClient
        ? `Winner ${winnerProgress.processedClients}/${winnerProgress.totalClients || "?"}: ${winnerProgress.currentClient}`
        : "Winner refresh in progress"
      : payload?.winnerReportsSnapshotDate
        ? `Winner refresh ${formatLastUpdated(payload.winnerReportsSnapshotDate).replace("Last update ", "")}`
        : "Winner reports not loaded yet";
    const winnerNextText = isScanningWinner ? "Winner auto-check paused during refresh" : formatWinnerNextCheckText();

    const warnings = (visibleData.warnings || []).map((item) => `<div class="warning-box">${escapeHtml(item)}</div>`).join("");

    let heroLeadTitle = "All clear";
    let heroLeadText = "Quiet snapshot right now.";
    if (largest && largest.total > 0) {
      heroLeadTitle = largest.client;
      if (activeClients.length === 1) {
        heroLeadText = "Only one client needs attention right now.";
      } else if (largest.total === 1) {
        heroLeadText = `${activeClients.length} clients need attention, but the pressure is still light.`;
      } else {
        heroLeadText = `${largest.total} unchecked item${largest.total === 1 ? "" : "s"} currently lead the backlog.`;
      }
    }

    host.style.background = darkMode ? DARK_BG : LIGHT_BG;
    host.style.color = darkMode ? "#EFFFFB" : "#111827";
    shadow.innerHTML = `<style>${DASHBOARD_CSS}</style>
      <div class="bm-page" data-theme="${darkMode ? "dark" : "light"}">
      <div class="bm-topbar">
        <div>BO Checklist <span class="bm-version">${escapeHtml(VERSION)}</span>${extra.progressLine ? ` <span style="opacity:.75;font-weight:600;">${escapeHtml(extra.progressLine)}</span>` : ""}</div>
        <div class="bm-topbar-actions">
          <input type="date" id="date-filter" value="${escapeHtml(selectedDateIso)}">
          <button type="button" id="today-button">Today</button>
          <button type="button" id="yesterday-button">Yesterday</button>
          <button type="button" id="apply-date-button">Apply date</button>
          <button type="button" id="refresh-button" class="bm-primary" ${isScanningStatus ? "disabled" : ""}>${isScanningStatus ? "Loading..." : "Refresh now"}</button>
          <div style="position:relative;">
            <button type="button" id="bm-settings" title="Settings">⋯</button>
            <div class="bm-menu" id="bm-menu" hidden>
              <button type="button" id="winner-refresh-button" ${isScanningWinner ? "disabled" : ""}>${isScanningWinner ? "Loading winner..." : "Refresh winner reports"}</button>
              <button type="button" id="night-toggle-button">${ignoreNightOnly ? "Include night tabs" : "Hide night tabs"}</button>
              <button type="button" id="hide-clear-button">${hideClearClients ? "Show clear clients" : "Hide clear clients"}</button>
              <button type="button" id="bm-theme">${darkMode ? "Light mode" : "Dark mode"}</button>
            </div>
          </div>
          <button type="button" id="bm-minimize">Minimize</button>
          <button type="button" id="bm-close">Close</button>
        </div>
      </div>
      <div class="app">
        ${warnings}

        <section class="summary-grid">
          <article class="summary-card">
            <div class="label">Unchecked total</div>
            <div class="value">${escapeHtml(totalUnchecked)}</div>
            <div class="subvalue">All visible BO badge counts combined for the current worker session.</div>
          </article>
          <article class="summary-card">
            <div class="label">Most loaded client</div>
            <div class="value">${escapeHtml(largest ? largest.total : 0)}</div>
            <div class="subvalue">${escapeHtml(largest && largest.total > 0 ? `${largest.client} currently has the biggest unchecked queue.` : "No active backlog right now.")}</div>
          </article>
          <article class="summary-card">
            <div class="label">Clients with work</div>
            <div class="value">${escapeHtml(activeClients.length)}</div>
            <div class="subvalue">${escapeHtml(activeClients.map((client) => client.client).join(", ") || "No active clients")}</div>
          </article>
          <article class="summary-card">
            <div class="label">Ticketing requests</div>
            <div class="value">${escapeHtml(requestsLabel)}</div>
            <div class="subvalue">Updates approximately every 5 minutes. <button type="button" id="requests-notifications" style="padding:3px 9px;font-size:10px;font-weight:700;background:#00987D;color:#fff;border:0;border-radius:8px;cursor:pointer;">${requestNotificationsEnabled && "Notification" in window && Notification.permission === "granted" ? "Disable notifications" : "Enable notifications"}</button></div>
          </article>
        </section>

        <section class="client-section">
          ${clients.map((client) => {
            const intensity = client.total / maxTotal;
            const quickReportsLeft = Number.isInteger(client.quickReports) ? client.quickReports : null;
            const winnerReportsLeftOnly = Number.isInteger(client.winnerReports) ? client.winnerReports : null;
            const showQuickReports = clientSupportsQuick(client.client);
            const quickReportsDisplay = quickReportsLeft == null ? "-" : escapeHtml(quickReportsLeft);
            const style = client.total > 0
              ? `style="background:
                linear-gradient(180deg, rgba(255,255,255,0.97), rgba(255,255,255,0.85)),
                linear-gradient(135deg, rgba(214,75,109,${0.06 + intensity * 0.12}), rgba(106,70,242,${0.05 + intensity * 0.12}));"`
              : "";
            return `
              <article class="client-card ${Number(client.total || 0) === 0 ? "zero" : ""} ${getQueueClientThemeClass(client.client)}" ${style}>
                <div class="client-head">
                  <div>
                    <div class="label">Client</div>
                    <div class="client-name">${escapeHtml(client.client)}</div>
                  </div>
                  <div class="client-head-actions">
                    <button
                      class="client-refresh-button"
                      type="button"
                      data-client-refresh="${escapeHtml(client.clientId)}"
                      title="Refresh only ${escapeHtml(client.client)}"
                      ${refreshingClientIds.has(String(client.clientId)) ? "disabled" : ""}
                    >${refreshingClientIds.has(String(client.clientId)) ? "..." : "&#8635;"}</button>
                    ${showQuickReports ? `<div class="quick-badge" title="Quick reports left">
                      <span class="badge-prefix">Q</span>
                      <span>${quickReportsDisplay}</span>
                    </div>` : ""}
                    <div class="winner-badge" title="Winner reports left">
                      <span class="badge-prefix">W</span>
                      <span>${winnerReportsLeftOnly == null ? "-" : escapeHtml(winnerReportsLeftOnly)}</span>
                    </div>
                    <div class="client-total">${escapeHtml(client.total)}</div>
                  </div>
                </div>

                <div class="tab-list">
                  ${client.nonZero.length
                    ? client.nonZero
                        .slice()
                        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
                        .map((item) => `
                          <div class="tab-row">
                            <div class="tab-label">${escapeHtml(item.label)}</div>
                            <div class="tab-count">${escapeHtml(item.count)}</div>
                          </div>
                        `)
                        .join("")
                    : `<div class="clear-state">No unchecked items for this client in the latest BO refresh.</div>`}
                </div>
              </article>
            `;
          }).join("")}
        </section>

        <section class="queue-grid">
          <article class="panel winner-panel">
            <div class="panel-head"><h3>Winner report queue <span class="panel-count">${winnerQueue.length}</span></h3></div>
            <div class="list">
              ${winnerQueue.slice(0, 12).map((item) => `
                <div class="list-item">
                  ${renderQueueClientPill(item.client || "Client")}
                  <div class="list-item-body">
                    <div class="list-item-title">${escapeHtml(item.playerId || "Unknown player")}</div>
                    ${(item.netWinningsText || item.aggregatedText) ? `
                      <div class="queue-extra">
                        ${item.netWinningsText ? `<div class="queue-extra-chip">Today win ${escapeHtml(item.netWinningsText)}</div>` : ""}
                        ${item.aggregatedText ? `<div class="queue-extra-chip">Agg ${escapeHtml(item.aggregatedText)}</div>` : ""}
                      </div>
                    ` : ""}
                  </div>
                  <div class="list-item-count ${escapeHtml(getReportPriorityClass(item.lastBetHours, item.lastBetText || "-"))}">${escapeHtml(formatReportAge(item.lastBetHours, item.lastBetText || "-"))}</div>
                </div>
              `).join("") || `<div class="list-item"><div class="hero-copy"><div class="list-item-title">No winner report candidates</div><div class="list-item-meta">Winner queue will appear here after the BO winner refresh finishes.</div></div><div class="list-item-count">0</div></div>`}
            </div>
          </article>

          <article class="panel quick-panel">
            <div class="panel-head"><h3>Quick report queue <span class="panel-count">${quickQueue.length}</span></h3></div>
            <div class="list">
              ${quickQueue.slice(0, 12).map((item) => `
                <div class="list-item">
                  ${renderQueueClientPill(item.client || "Client")}
                  <div class="list-item-body">
                    <div class="list-item-title">${escapeHtml(item.playerId || "Unknown player")}</div>
                    ${(item.netWinningsText || item.aggregatedText) ? `
                      <div class="queue-extra">
                        ${item.netWinningsText ? `<div class="queue-extra-chip">Today win ${escapeHtml(item.netWinningsText)}</div>` : ""}
                        ${item.aggregatedText ? `<div class="queue-extra-chip">Agg ${escapeHtml(item.aggregatedText)}</div>` : ""}
                      </div>
                    ` : ""}
                  </div>
                  <div class="list-item-count ${escapeHtml(getReportPriorityClass(item.lastBetHours, item.lastBetText || "-"))}">${escapeHtml(formatReportAge(item.lastBetHours, item.lastBetText || "-"))}</div>
                </div>
              `).join("") || `<div class="list-item"><div class="hero-copy"><div class="list-item-title">No quick report candidates</div><div class="list-item-meta">Quick queue is empty in the latest BO snapshot.</div></div><div class="list-item-count">0</div></div>`}
            </div>
          </article>

          <article class="panel completed-panel done-panel">
            <div class="panel-head"><h3>Completed reports <span class="panel-count panel-count-completed">${completedQueue.length}</span></h3></div>
            <div class="list">
              ${visibleCompletedQueue.map((item) => `
                <div class="list-item completed">
                  ${renderQueueClientPill(item.client || "Client")}
                  <div class="list-item-body">
                    <div class="list-item-title">${escapeHtml(item.playerId || "Unknown player")}</div>
                    ${(item.netWinningsText || item.aggregatedText) ? `
                      <div class="queue-extra">
                        ${item.netWinningsText ? `<div class="queue-extra-chip">Today win ${escapeHtml(item.netWinningsText)}</div>` : ""}
                        ${item.aggregatedText ? `<div class="queue-extra-chip">Agg ${escapeHtml(item.aggregatedText)}</div>` : ""}
                      </div>
                    ` : ""}
                  </div>
                  <div class="list-item-count">&#10003;</div>
                </div>
              `).join("") || `<div class="list-item"><div class="hero-copy"><div class="list-item-title">No completed reports yet</div><div class="list-item-meta">Completed winner reports will appear here once generated.</div></div><div class="list-item-count">0</div></div>`}
            </div>
            ${completedQueue.length > COMPLETED_REPORTS_COLLAPSED_LIMIT ? `
              <div style="margin-top:14px; display:flex; justify-content:center;">
                <button class="secondary" id="completed-reports-toggle" type="button">
                  ${completedReportsExpanded ? "Show less" : `View more (${completedQueue.length - COMPLETED_REPORTS_COLLAPSED_LIMIT})`}
                </button>
              </div>
            ` : ""}
          </article>
        </section>

        <section class="panel-grid">
          <article class="panel mailing-panel">
            <div class="panel-head">
              <h3>Mailing check <span class="panel-count">${escapeHtml(mailingTotal)}</span></h3>
              <div class="panel-head-actions">
                <button class="panel-refresh-button" id="mailing-refresh-button" type="button" ${isScanningWinner ? "disabled" : ""}>
                  ${isScanningWinner ? "Loading..." : "Refresh"}
                </button>
              </div>
            </div>
            <div class="list">
              ${mailingClients.slice(0, 8).map((client) => {
                const tabs = (client.tabs || []).filter((tab) => (Number(tab.count) || 0) > 0);
                return `
                  <div class="list-item mailing-item" style="display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;">
                    ${renderQueueClientPill(client.client || "Client")}
                    <div class="list-item-body" style="display:grid;gap:4px;min-width:0;justify-items:start;">
                      <div class="list-item-title" style="text-align:left;">${escapeHtml(client.client || "Client")}</div>
                      <div class="queue-extra" style="margin-top:0;">
                        ${tabs.map((tab) => `<div class="queue-extra-chip">${escapeHtml(tab.label)} ${escapeHtml(tab.count)}</div>`).join("")}
                      </div>
                    </div>
                    <div class="list-item-count">${escapeHtml(client.total)}</div>
                  </div>
                `;
              }).join("") || `<div class="list-item"><div class="hero-copy"><div class="list-item-title">Mailing tabs are clear</div><div class="list-item-meta">No pending mailing badge counts in BO.</div></div><div class="list-item-count">0</div></div>`}
              ${mailingClients.length > 8 ? `<div class="list-item"><div class="hero-copy"><div class="list-item-title">More clients</div><div class="list-item-meta">${escapeHtml(mailingClients.length - 8)} more with mailing badges.</div></div><div class="list-item-count">+</div></div>` : ""}
            </div>
          </article>
        </section>

        <section class="footer-note">
          Source: <strong>lfscbo.com/#lfs/toCheck/index</strong>.
          Auto-refresh interval: <strong>${Math.round(REFRESH_MS / 60000)} minutes</strong>.
          Winner reports refresh: <strong>${Math.round(WINNER_REFRESH_MS / 60000)} minutes</strong>.
          This overview uses your logged-in BO session; no data leaves the browser.
        </section>
      </div>
      </div>
    `;

    shadow.getElementById("bm-theme")?.addEventListener("click", () => {
      darkMode = !darkMode;
      localStorage.setItem(THEME_STORAGE_KEY, darkMode ? "dark" : "light");
      render(currentPayload);
    });
    shadow.getElementById("bm-settings")?.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = shadow.getElementById("bm-menu");
      if (menu) {
        menu.hidden = !menu.hidden;
      }
    });

    shadow.getElementById("bm-minimize")?.addEventListener("click", () => {
      minimized = true;
      render(currentPayload);
    });
    shadow.getElementById("bm-close")?.addEventListener("click", closePanel);
    shadow.getElementById("refresh-button")?.addEventListener("click", () => runOverviewScan());
    shadow.getElementById("winner-refresh-button")?.addEventListener("click", () => runWinnerScan());
    shadow.getElementById("mailing-refresh-button")?.addEventListener("click", () => runWinnerScan());
    shadow.getElementById("apply-date-button")?.addEventListener("click", () => {
      selectedDateIso = shadow.getElementById("date-filter")?.value || selectedDateIso;
      runOverviewScan();
      runWinnerScan();
    });
    shadow.getElementById("today-button")?.addEventListener("click", () => {
      selectedDateIso = getIsoDate();
      runOverviewScan();
      runWinnerScan();
    });
    shadow.getElementById("yesterday-button")?.addEventListener("click", () => {
      const date = new Date();
      date.setDate(date.getDate() - 1);
      selectedDateIso = getIsoDate(date);
      runOverviewScan();
      runWinnerScan();
    });
    shadow.getElementById("night-toggle-button")?.addEventListener("click", () => {
      ignoreNightOnly = !ignoreNightOnly;
      localStorage.setItem(NIGHT_FILTER_STORAGE_KEY, ignoreNightOnly ? "1" : "0");
      render(currentPayload);
    });
    shadow.getElementById("hide-clear-button")?.addEventListener("click", () => {
      hideClearClients = !hideClearClients;
      localStorage.setItem(HIDE_CLEAR_STORAGE_KEY, hideClearClients ? "1" : "0");
      render(currentPayload);
    });
    shadow.getElementById("completed-reports-toggle")?.addEventListener("click", () => {
      completedReportsExpanded = !completedReportsExpanded;
      render(currentPayload);
    });
    shadow.getElementById("requests-notifications")?.addEventListener("click", async () => {
      if (!("Notification" in window)) {
        alert("Notifications are not supported in this browser.");
        return;
      }
      if (requestNotificationsEnabled && Notification.permission === "granted") {
        requestNotificationsEnabled = false;
      } else {
        try {
          requestNotificationsEnabled = (await Notification.requestPermission()) === "granted";
        } catch {
          requestNotificationsEnabled = false;
        }
      }
      localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, requestNotificationsEnabled ? "1" : "0");
      render(currentPayload);
    });
    shadow.querySelectorAll("[data-client-refresh]").forEach((button) => {
      button.addEventListener("click", () => refreshSingleClient(button.dataset.clientRefresh));
    });
  }

  // Live countdown for the "next winner check" chip.
  window.setInterval(() => {
    if (window[CLOSED_FLAG] || minimized) {
      return;
    }
    const chip = shadow.getElementById("winner-next-chip");
    if (chip && !isScanningWinner) {
      chip.textContent = formatWinnerNextCheckText();
    }
  }, 1000);

  async function refreshSingleClient(clientId) {
    const id = String(clientId);
    if (refreshingClientIds.has(id)) {
      return;
    }
    if (!userConsented && !ensureConsent()) {
      return;
    }
    refreshingClientIds.add(id);
    render(currentPayload);

    return withBoLock(async () => {
      try {
        const isoDate = selectedDateIso;
        const displayDate = getDisplayDateFromIso(isoDate);
        const known = overviewResults.find((client) => String(client.clientId) === id);
        if (!known) {
          return;
        }
        const clientRef = { id, client: known.client };

        await boFetch(`/ajax.php?q=core/userTeamSelect&type=lfs&val=${encodeURIComponent(id)}`);
        await sleep(400);
        const toCheckHtml = await fetchToCheckHtmlWithLateTabs(isoDate, clientRef.client);
        const fresh = collectClient(clientRef, toCheckHtml);
        overviewResults = overviewResults.map((client) => (String(client.clientId) === id ? fresh : client));
        overviewSnapshotAt = new Date().toISOString();

        try {
          const winnerOverview = await collectWinnerForClient(clientRef, isoDate, displayDate);
          winnerClients = { ...winnerClients, [id]: { ...winnerOverview.winnerCounts } };
          winnerReportQueue = [...winnerReportQueue.filter((item) => String(item.clientId) !== id), ...winnerOverview.reportQueueItems].sort(
            (a, b) => (b.lastBetHours ?? -1) - (a.lastBetHours ?? -1),
          );
          winnerCompletedQueue = [...winnerCompletedQueue.filter((item) => String(item.clientId) !== id), ...winnerOverview.completedQueueItems];
          winnerSnapshotAt = new Date().toISOString();
        } catch (error) {
          warningsBatch = [...new Set([...warningsBatch, `${clientRef.client}: ${error.message}`])];
        }

        let mailing = [];
        try {
          const mailerHtml = await boFetch("/ajax.php?q=lfs/ticketing/mailer");
          mailing = parseMailerTabsFromHtml(mailerHtml).filter((tab) => tab.count > 0);
        } catch {
          mailing = [];
        }
        winnerMailingRows = [
          ...winnerMailingRows.filter((row) => String(row.clientId) !== id),
          ...(mailing.length ? [{ client: clientRef.client, clientId: id, tabs: mailing }] : []),
        ];

        restoreOriginalClient();
        render(mergePayload());
      } finally {
        refreshingClientIds.delete(id);
        render(currentPayload);
      }
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

  let boQueue = Promise.resolve();
  let warningsBatch = [];

  function withBoLock(work) {
    const run = boQueue.catch(() => {}).then(work);
    boQueue = run.catch(() => {});
    return run;
  }

  function mergePayload() {
    const clients = overviewResults.map((client) => ({
      ...client,
      ...(winnerClients[client.clientId] || {}),
    }));
    const sorted = [...clients].sort((a, b) => b.total - a.total || a.client.localeCompare(b.client));
    currentPayload = {
      snapshotDate: overviewSnapshotAt,
      winnerReportsSnapshotDate: winnerSnapshotAt,
      ticketing: ticketingData,
      clients: sorted,
      reportQueue: winnerReportQueue,
      completedQueue: winnerCompletedQueue,
      mailing: winnerMailingRows,
      warnings: [...new Set(warningsBatch)],
    };
    return currentPayload;
  }

  function ensureConsent() {
    userConsented = window.confirm(
      "BO Checklist: scans switch the active BO client in THIS browser session.\n\n" +
        "Recommended: run this in a separate browser or an incognito window with its own BO login, " +
        "not in the browser you work in.\n\nStart the scans here?",
    );
    if (!userConsented) {
      statusLine = "Scan cancelled. Open lfscbo.com in a separate browser session and press Scan there.";
      render(mergePayload());
    }
    return userConsented;
  }

  async function runOverviewScan() {
    if (isScanningStatus) {
      return;
    }

    if (!userConsented && !ensureConsent()) {
      return;
    }

    return withBoLock(async () => {
      isScanningStatus = true;
      statusLine = "Statuses: scanning...";
      statusProgress.inProgress = true;
      statusProgress.processedClients = 0;
      statusProgress.totalClients = 0;
      statusProgress.currentClient = null;
      render(mergePayload());

      try {
        const isoDate = selectedDateIso;
        const baseHtml = await fetchToCheckHtml(isoDate);

        if (isLoginPage(baseHtml)) {
          throw new Error("BO session expired. Log in to lfscbo.com again.");
        }

        const clients = parseClientsFromHtml(baseHtml);
        if (!clients.length) {
          throw new Error("Could not parse client list from BO");
        }

        // The BO dropdown can transiently lose some teams between refreshes.
        // Keep scanning clients we already know about from the previous pass.
        if (overviewResults.length) {
          const seen = new Map(clients.map((client) => [client.id, client]));
          const missing = [];
          for (const previous of overviewResults) {
            if (!seen.has(previous.clientId)) {
              seen.set(previous.clientId, { id: previous.clientId, client: previous.client });
              missing.push(previous.client);
            }
          }
          if (missing.length) {
            warningsBatch = [
              ...new Set([
                ...warningsBatch,
                `Statuses: ${missing.join(", ")} missing from client list - scanning by last known id`,
              ]),
            ];
          }
          clients.length = 0;
          clients.push(...seen.values());
        }

        originalClientId = clients.find((client) => client.selected)?.id || null;
        ticketingData = await Promise.resolve()
          .then(() => fetch("/ajax.php?q=lfs/ticketing", { credentials: "same-origin" }).then((response) => response.text()))
          .then(parseTicketingRequests)
          .catch(() => null)
          .then((requests) => ({ requests }));

        const results = [];
        for (let index = 0; index < clients.length; index += 1) {
          const clientRef = clients[index];
          statusProgress.totalClients = clients.length;
          statusProgress.processedClients = index;
          statusProgress.currentClient = clientRef.client;
          statusLine = `Statuses ${index + 1} / ${clients.length}`;
          render(mergePayload(), { progressLine: `${statusLine} — ${clientRef.client}` });

          await boFetch(`/ajax.php?q=core/userTeamSelect&type=lfs&val=${encodeURIComponent(clientRef.id)}`);
          await sleep(400);
          const toCheckHtml = await fetchToCheckHtmlWithLateTabs(isoDate, clientRef.client);
          results.push(collectClient(clientRef, toCheckHtml));
          await sleep(SCAN_STEP_DELAY_MS);
        }

        restoreOriginalClient();

        overviewResults = results;
        overviewSnapshotAt = new Date().toISOString();
        warningsBatch = warningsBatch.filter((line) => !line.startsWith("Statuses:"));
        statusLine = "Statuses done.";
        render(mergePayload());
      } catch (error) {
        warningsBatch = [...warningsBatch, `Statuses: ${error.message}`];
        statusLine = `Error: ${error.message}`;
        restoreOriginalClient();
        render(mergePayload());
      } finally {
        isScanningStatus = false;
        statusProgress.inProgress = false;
        statusProgress.processedClients = statusProgress.totalClients || statusProgress.processedClients;
        statusProgress.currentClient = null;
        render(mergePayload());

        window.clearTimeout(window[TIMER_FLAG]);
        window[TIMER_FLAG] = window.setTimeout(runOverviewScan, REFRESH_MS);
      }
    });
  }

  function emptyWinnerCounts() {
    return {
      quickReports: null,
      quickReportsCompleted: null,
      quickReportsTotal: null,
      quickReportsConfidence: "error",
      winnerReports: null,
      winnerReportsCompleted: null,
      winnerReportsTotal: null,
      winnerReportsConfidence: "error",
    };
  }

  async function runWinnerScan() {
    if (isScanningWinner) {
      return;
    }

    if (!userConsented && !ensureConsent()) {
      return;
    }

    return withBoLock(async () => {
      isScanningWinner = true;
      statusLine = "Winner reports: scanning...";
      winnerProgress.inProgress = true;
      winnerProgress.processedClients = 0;
      winnerProgress.totalClients = 0;
      winnerProgress.currentClient = null;
      render(mergePayload());

      const nextWinnerClients = {};
      const nextReportQueue = [];
      const nextCompletedQueue = [];
      const nextMailingRows = [];

      try {
        const isoDate = selectedDateIso;
        const displayDate = getDisplayDateFromIso(isoDate);

        let clientRefs = overviewResults.map((client) => ({ id: client.clientId, client: client.client }));
        if (!clientRefs.length) {
          const baseHtml = await fetchToCheckHtml(isoDate);
          if (isLoginPage(baseHtml)) {
            throw new Error("BO session expired. Log in to lfscbo.com again.");
          }
          clientRefs = parseClientsFromHtml(baseHtml);
        }

        for (let index = 0; index < clientRefs.length; index += 1) {
          const clientRef = clientRefs[index];
          winnerProgress.totalClients = clientRefs.length;
          winnerProgress.processedClients = index;
          winnerProgress.currentClient = clientRef.client;
          statusLine = `Winner reports ${index + 1} / ${clientRefs.length}`;
          render(mergePayload(), { progressLine: `${statusLine} — ${clientRef.client}` });

          await boFetch(`/ajax.php?q=core/userTeamSelect&type=lfs&val=${encodeURIComponent(clientRef.id)}`);

          let winnerCounts = emptyWinnerCounts();
          let queueItems = [];
          let completedItems = [];

          try {
            const winnerOverview = await collectWinnerForClient(clientRef, isoDate, displayDate);
            winnerCounts = winnerOverview.winnerCounts;
            queueItems = winnerOverview.reportQueueItems;
            completedItems = winnerOverview.completedQueueItems;
          } catch (error) {
            warningsBatch = [...new Set([...warningsBatch, `${clientRef.client}: ${error.message}`])];
          }

          let mailing = [];
          try {
            const mailerHtml = await boFetch("/ajax.php?q=lfs/ticketing/mailer");
            mailing = parseMailerTabsFromHtml(mailerHtml).filter((tab) => tab.count > 0);
          } catch {
            mailing = [];
          }
          if (mailing.length) {
            nextMailingRows.push({ client: clientRef.client, clientId: clientRef.id, tabs: mailing });
          }

          nextWinnerClients[clientRef.id] = { ...winnerCounts };
          nextReportQueue.push(...queueItems);
          nextCompletedQueue.push(...completedItems);

          statusLine = `Winner reports ${index + 1} / ${clientRefs.length}`;
          render(
            mergePayload(),
            {
              progressLine: `${statusLine} — ${clientRef.client} (winner ${winnerCounts.winnerReports ?? "?"}, quick ${winnerCounts.quickReports ?? "?"})`,
            },
          );
          await sleep(SCAN_STEP_DELAY_MS);
        }

        restoreOriginalClient();

        winnerClients = nextWinnerClients;
        winnerReportQueue = nextReportQueue.sort((a, b) => (b.lastBetHours ?? -1) - (a.lastBetHours ?? -1));
        winnerCompletedQueue = nextCompletedQueue;
        winnerMailingRows = nextMailingRows;
        winnerSnapshotAt = new Date().toISOString();
        warningsBatch = warningsBatch.filter((line) => !line.startsWith("Winner:"));
        statusLine = "Winner reports done.";
        render(mergePayload());
      } catch (error) {
        warningsBatch = [...warningsBatch, `Winner: ${error.message}`];
        statusLine = `Error: ${error.message}`;
        restoreOriginalClient();
        render(mergePayload());
      } finally {
        isScanningWinner = false;
        winnerProgress.inProgress = false;
        winnerProgress.processedClients = winnerProgress.totalClients || winnerProgress.processedClients;
        winnerProgress.currentClient = null;
        render(mergePayload());

        window.clearTimeout(window[WINNER_TIMER_FLAG]);
        window[WINNER_TIMER_FLAG] = window.setTimeout(runWinnerScan, WINNER_REFRESH_MS);
      }
    });
  }


  render(mergePayload());
  runOverviewScan();
  runWinnerScan();
})();
