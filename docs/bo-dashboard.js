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
  const NOTIFICATIONS_STORAGE_KEY = "bo-request-notifications";
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

  const VERSION = "v2.0";
  const DASHBOARD_CSS = "    :root {\n      --bg: #f6f1e8;\n      --bg-accent: #ece2cf;\n      --ink: #111827;\n      --muted: #6b6a68;\n      --line: rgba(17, 24, 39, 0.1);\n      --card: rgba(255, 255, 255, 0.84);\n      --card-strong: rgba(255, 255, 255, 0.95);\n      --shadow: 0 24px 60px rgba(35, 28, 22, 0.13);\n      --green: #0aa36c;\n      --green-soft: rgba(10, 163, 108, 0.14);\n      --blue: #2176d8;\n      --blue-soft: rgba(33, 118, 216, 0.12);\n      --violet: #6a46f2;\n      --violet-soft: rgba(106, 70, 242, 0.12);\n      --rose: #d64b6d;\n      --rose-soft: rgba(214, 75, 109, 0.15);\n      --gold: #d58b1d;\n      --gold-soft: rgba(213, 139, 29, 0.15);\n    }\n\n    * { box-sizing: border-box; }\n\n    body {\n      margin: 0;\n      min-height: 100vh;\n      font-family: \"Segoe UI\", \"Trebuchet MS\", sans-serif;\n      color: var(--ink);\n      background:\n        radial-gradient(circle at top left, rgba(10, 163, 108, 0.12), transparent 25%),\n        radial-gradient(circle at top right, rgba(106, 70, 242, 0.16), transparent 28%),\n        linear-gradient(180deg, #fbf7f0 0%, var(--bg) 55%, var(--bg-accent) 100%);\n    }\n\n    .app {\n      width: min(1500px, calc(100vw - 40px));\n      margin: 26px auto;\n      display: grid;\n      gap: 18px;\n    }\n\n    .hero,\n    .panel,\n    .summary-card,\n    .client-card,\n    .login-card,\n    .footer-note {\n      background: var(--card);\n      border: 1px solid var(--line);\n      border-radius: 26px;\n      box-shadow: var(--shadow);\n      backdrop-filter: blur(12px);\n    }\n\n    .hidden { display: none !important; }\n\n    .login-wrap {\n      min-height: calc(100vh - 80px);\n      display: grid;\n      place-items: center;\n    }\n\n    .loading-wrap {\n      min-height: calc(100vh - 80px);\n      display: grid;\n      place-items: center;\n    }\n\n    .login-card {\n      width: min(900px, 100%);\n      overflow: hidden;\n      display: grid;\n      grid-template-columns: 1fr;\n    }\n\n    .login-form {\n      padding: 34px;\n    }\n\n    .loading-card {\n      width: min(980px, 100%);\n      padding: 34px;\n      position: relative;\n      overflow: hidden;\n      color: #fff;\n      background:\n        linear-gradient(135deg, rgba(214, 129, 28, 0.95) 0%, rgba(109, 58, 212, 0.92) 56%, rgba(21, 116, 215, 0.86) 100%);\n    }\n\n    .loading-card::after {\n      content: \"\";\n      position: absolute;\n      inset: 0;\n      background:\n        linear-gradient(120deg, rgba(255, 255, 255, 0.18) 0 14%, transparent 14% 100%),\n        linear-gradient(0deg, rgba(6, 20, 48, 0.16), rgba(6, 20, 48, 0.16));\n      pointer-events: none;\n    }\n\n    .loading-card > * {\n      position: relative;\n      z-index: 1;\n    }\n\n    .loading-card h1 {\n      margin: 18px 0 14px;\n      max-width: 10ch;\n      font-size: clamp(42px, 6vw, 72px);\n      line-height: 0.94;\n      letter-spacing: -0.06em;\n    }\n\n    .loading-card p {\n      margin: 0;\n      max-width: 50ch;\n      color: rgba(255, 255, 255, 0.88);\n      line-height: 1.6;\n      font-size: 15px;\n    }\n\n    .loading-steps {\n      margin-top: 22px;\n      display: grid;\n      gap: 6px;\n    }\n\n    .loading-step {\n      padding: 7px 9px;\n      border-radius: 16px;\n      background: rgba(255, 255, 255, 0.12);\n      border: 1px solid rgba(255, 255, 255, 0.16);\n      color: rgba(255, 255, 255, 0.9);\n      line-height: 1.35;\n    }\n\n    .login-form {\n      width: 100%;\n      margin: 0 auto;\n      background: rgba(255, 255, 255, 0.9);\n    }\n\n    .pill,\n    .chip,\n    .status-badge {\n      display: inline-flex;\n      align-items: center;\n      gap: 6px;\n      padding: 9px 14px;\n      border-radius: 999px;\n      font-size: 11px;\n      font-weight: 800;\n      letter-spacing: 0.12em;\n      text-transform: uppercase;\n    }\n\n    .pill {\n      color: var(--green);\n      background: var(--green-soft);\n    }\n\n    .login-form h1 {\n      margin: 20px 0 14px;\n      font-size: clamp(42px, 5vw, 64px);\n      line-height: 0.94;\n      letter-spacing: -0.06em;\n    }\n\n    .login-copy,\n    .helper,\n    .muted {\n      color: rgba(15, 63, 53, 0.78);\n      line-height: 1.6;\n    }\n\n    .field {\n      display: grid;\n      gap: 6px;\n      margin-top: 18px;\n    }\n\n    .field label {\n      font-size: 11px;\n      font-weight: 800;\n      letter-spacing: 0.16em;\n      text-transform: uppercase;\n      color: rgba(15, 63, 53, 0.68);\n    }\n\n    .field input {\n      width: 100%;\n      border: 1px solid rgba(17, 24, 39, 0.12);\n      border-radius: 16px;\n      background: rgba(255, 255, 255, 0.95);\n      padding: 16px 18px;\n      font-size: 15px;\n      color: var(--ink);\n      outline: none;\n    }\n\n    .field input:focus {\n      border-color: rgba(33, 118, 216, 0.55);\n      box-shadow: 0 0 0 4px rgba(33, 118, 216, 0.12);\n    }\n\n    .actions {\n      display: flex;\n      flex-wrap: wrap;\n      gap: 6px;\n      margin-top: 22px;\n    }\n\n    button {\n      border: 0;\n      cursor: pointer;\n      border-radius: 16px;\n      padding: 12px 16px;\n      font-size: 15px;\n      font-weight: 800;\n      font-family: inherit;\n      transition: transform 0.18s ease, background 0.18s ease, color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;\n    }\n\n    .primary {\n      background: #161616;\n      color: #fff;\n    }\n\n    .secondary {\n      background: #fff;\n      color: var(--ink);\n      border: 1px solid rgba(17, 24, 39, 0.12);\n    }\n\n    #refresh-button {\n      background: #ffffff;\n      color: #0b3b31;\n      border: 1px solid rgba(255, 255, 255, 0.7);\n      box-shadow: 0 10px 22px rgba(4, 57, 39, 0.18);\n    }\n\n    #apply-date-button {\n      background: rgba(255, 255, 255, 0.92);\n      color: #0f3f35;\n      border: 1px solid rgba(255, 255, 255, 0.58);\n      box-shadow: 0 6px 14px rgba(4, 57, 39, 0.1);\n    }\n\n    #winner-refresh-button {\n      background: rgba(255, 255, 255, 0.18);\n      color: #f3fffb;\n      border: 1px solid rgba(255, 255, 255, 0.24);\n      box-shadow: none;\n    }\n\n    #logout-button {\n      background: rgba(4, 57, 39, 0.14);\n      color: rgba(239, 255, 249, 0.9);\n      border: 1px solid rgba(255, 255, 255, 0.14);\n      box-shadow: none;\n    }\n\n    #refresh-button:hover {\n      transform: translateY(-1px);\n      background: #f6fffc;\n      border-color: rgba(11, 59, 49, 0.18);\n      box-shadow: 0 14px 28px rgba(4, 57, 39, 0.2);\n    }\n\n    #apply-date-button:hover {\n      transform: translateY(-1px);\n      background: #ffffff;\n      border-color: rgba(15, 63, 53, 0.22);\n      box-shadow: 0 10px 18px rgba(4, 57, 39, 0.12);\n    }\n\n    #winner-refresh-button:hover {\n      transform: translateY(-1px);\n      background: rgba(255, 255, 255, 0.26);\n      border-color: rgba(255, 255, 255, 0.34);\n      box-shadow: 0 10px 22px rgba(4, 57, 39, 0.12);\n    }\n\n    #logout-button:hover {\n      transform: translateY(-1px);\n      background: rgba(4, 57, 39, 0.24);\n      border-color: rgba(255, 255, 255, 0.22);\n      box-shadow: 0 8px 18px rgba(4, 57, 39, 0.1);\n    }\n\n    #refresh-button:disabled,\n    #apply-date-button:disabled,\n    #winner-refresh-button:disabled,\n    #logout-button:disabled {\n      opacity: 0.7;\n      transform: none;\n    }\n.login-side {\n      position: relative;\n      overflow: hidden;\n      color: #fff;\n      background:\n        linear-gradient(135deg, rgba(214, 129, 28, 0.95) 0%, rgba(140, 70, 217, 0.92) 54%, rgba(24, 117, 215, 0.86) 100%);\n    }\n\n    .login-side::before {\n      content: \"\";\n      position: absolute;\n      inset: auto -10% -30% auto;\n      width: 420px;\n      height: 420px;\n      border-radius: 50%;\n      background: rgba(255, 255, 255, 0.16);\n    }\n\n    .login-side > * {\n      position: relative;\n      z-index: 1;\n    }\n\n    .login-side h2 {\n      margin: 26px 0 14px;\n      font-size: clamp(42px, 5vw, 72px);\n      line-height: 0.94;\n      letter-spacing: -0.06em;\n    }\n\n    .login-side p {\n      max-width: 34rem;\n      color: rgba(255, 255, 255, 0.88);\n      line-height: 1.6;\n      font-size: 15px;\n    }\n\n    .inline-stats {\n      display: flex;\n      flex-wrap: wrap;\n      gap: 6px;\n      margin-top: 28px;\n    }\n\n    .chip {\n      background: rgba(255, 255, 255, 0.16);\n      color: #fff;\n      border: 1px solid rgba(255, 255, 255, 0.2);\n    }\n\n    .hero {\n      position: relative;\n      overflow: hidden;\n      padding: 7px 9px;\n      background:\n        linear-gradient(135deg, rgba(0, 14, 11, 0.98) 0%, rgba(0, 155, 125, 0.96) 42%, rgba(0, 244, 187, 0.92) 100%);\n      color: #fff;\n    }\n\n    .hero::after {\n      content: \"\";\n      position: absolute;\n      inset: 0;\n      background:\n        linear-gradient(120deg, rgba(204, 253, 241, 0.18) 0 14%, transparent 14% 100%),\n        linear-gradient(0deg, rgba(4, 57, 39, 0.16), rgba(4, 57, 39, 0.16));\n      pointer-events: none;\n    }\n\n    .hero > * {\n      position: relative;\n      z-index: 1;\n    }\n\n    .hero-top,\n    .toolbar {\n      display: flex;\n      justify-content: flex-start;\n      gap: 5px;\n      align-items: center;\n      flex-wrap: wrap;\n    }\n\n    .hero-bottom {\n      display: flex;\n      justify-content: flex-start;\n      gap: 3px;\n      align-items: center;\n      align-content: flex-start;\n      flex-wrap: wrap;\n    }\n\n    .hero-top {\n      margin-bottom: 5px;\n    }\n\n    .hero-main {\n      margin-bottom: 5px;\n    }\n\n    .hero .chip,\n    .hero .pill,\n    .hero .status-badge {\n      padding: 7px 10px;\n      border-radius: 14px;\n      font-size: 11px;\n      line-height: 1.1;\n    }\n\n    #winner-update-chip {\n      flex: 1 1 100%;\n      min-height: 22px;\n      justify-content: flex-start;\n      white-space: nowrap;\n      overflow: hidden;\n      text-overflow: ellipsis;\n      padding-top: 4px;\n      padding-bottom: 4px;\n    }\n    .hero-main {\n      display: grid;\n      grid-template-columns: minmax(0, 1.35fr) minmax(220px, 0.72fr);\n      gap: 6px;\n      align-items: stretch;\n    }\n\n    .hero h2 {\n      margin: 0 0 2px;\n      max-width: 10ch;\n      font-size: clamp(20px, 3.2vw, 34px);\n      line-height: 0.91;\n      letter-spacing: -0.06em;\n    }\n\n    .hero p {\n      margin: 0;\n      max-width: 52ch;\n      font-size: 11px;\n      color: rgba(255, 255, 255, 0.84);\n      line-height: 1.18;\n    }\n\n    .hero-copy {\n      display: grid;\n      gap: 6px;\n      align-content: end;\n    }\n\n    .hero-side {\n      display: grid;\n      gap: 3px;\n    }\n\n    .hero-stat {\n      padding: 6px 8px;\n      border-radius: 12px;\n      background: rgba(255, 255, 255, 0.11);\n      border: 1px solid rgba(255, 255, 255, 0.14);\n    }\n\n    .hero-stat strong {\n      display: block;\n      font-size: 18px;\n      line-height: 1;\n      margin-bottom: 2px;\n    }\n\n    .hero-stat span {\n      color: rgba(255, 255, 255, 0.82);\n      line-height: 1.18;\n      font-size: 9px;\n    }\n\n    .toolbar {\n      margin-top: 3px;\n    }\n\n    .toolbar-right,\n    .date-controls,\n    .quick-date-actions {\n      display: flex;\n      align-items: center;\n      gap: 6px;\n      flex-wrap: wrap;\n    }\n\n    .date-input {\n      border: 1px solid rgba(255, 255, 255, 0.2);\n      background: rgba(255, 255, 255, 0.12);\n      color: #fff;\n      border-radius: 12px;\n      padding: 5px 8px;\n      font: inherit;\n      font-weight: 700;\n    }\n\n    .date-input::-webkit-calendar-picker-indicator {\n      filter: invert(1);\n      cursor: pointer;\n    }\n    .ghost-button {\n      background: rgba(255, 255, 255, 0.12);\n      color: #fff;\n      border: 1px solid rgba(255, 255, 255, 0.2);\n      padding: 7px 9px;\n    }\n\n\n    .status-badge {\n      background: rgba(255, 255, 255, 0.16);\n      color: #fff;\n      border: 1px solid rgba(255, 255, 255, 0.16);\n    }\n\n    .warning-box {\n      padding: 14px 18px;\n      border-radius: 18px;\n      background: rgba(255, 255, 255, 0.16);\n      color: #fff;\n      line-height: 1.55;\n    }\n\n    .summary-grid,\n    .client-section {\n      display: grid;\n      grid-template-columns: repeat(4, minmax(0, 1fr));\n      gap: 14px;\n    }\n\n    .dashboard-board {\n      display: grid;\n      grid-template-columns: repeat(2, minmax(0, 1fr));\n      gap: 14px;\n      align-items: start;\n    }\n\n    .board-item {\n      min-width: 0;\n    }\n\n    .board-item.span-1 { grid-column: span 1; }\n    .board-item.span-2 { grid-column: span 2; }\n    .board-item.span-4 { grid-column: span 2; }\n\n    .board-group {\n      display: grid;\n      gap: 6px;\n      min-width: 0;\n      position: relative;\n    }\n\n    .draggable-card {\n      cursor: default;\n    }\n\n    .dragging {\n      opacity: 0.45;\n      transform: scale(0.985);\n    }\n\n    .drop-target {\n      outline: 2px dashed rgba(33, 118, 216, 0.45);\n      outline-offset: 4px;\n    }\n\n    .card-topline {\n      display: flex;\n      justify-content: flex-start;\n      align-items: center;\n      gap: 6px;\n      margin-bottom: 10px;\n    }\n\n    .drag-edge-handle {\n      position: absolute;\n      top: 10px;\n      right: 6px;\n      width: 18px;\n      height: 18px;\n      border-radius: 999px;\n      background: transparent;\n      border: 0;\n      cursor: grab;\n      z-index: 3;\n      opacity: 0.72;\n    }\n\n    .drag-edge-handle::after {\n      content: \"\";\n      position: absolute;\n      top: 50%;\n      left: 50%;\n      width: 3px;\n      height: 12px;\n      transform: translate(-50%, -50%);\n      border-radius: 999px;\n      background:\n        radial-gradient(circle, rgba(116, 135, 165, 0.9) 0 1px, transparent 1.1px) center top / 3px 5px repeat-y;\n      opacity: 0.95;\n    }\n\n    .drag-edge-handle:hover {\n      background: rgba(116, 135, 165, 0.08);\n    }\n\n    .drag-edge-handle:active {\n      cursor: grabbing;\n    }\n\n    .summary-card,\n    .panel,\n    .client-card,\n    .footer-note {\n      padding: 20px;\n    }\n\n    .label {\n      color: var(--muted);\n      font-size: 11px;\n      font-weight: 800;\n      letter-spacing: 0.16em;\n      text-transform: uppercase;\n    }\n\n    .value {\n      margin-top: 12px;\n      font-size: clamp(34px, 5vw, 54px);\n      line-height: 0.96;\n      font-weight: 900;\n      letter-spacing: -0.05em;\n    }\n\n    .subvalue {\n      margin-top: 8px;\n      color: var(--muted);\n      line-height: 1.5;\n    }\n\n    .panel-grid {\n      display: grid;\n      grid-template-columns: 1.15fr 0.85fr;\n      gap: 14px;\n    }\n\n    .queue-grid {\n      display: grid;\n      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));\n      gap: 14px;\n    }\n\n    .panel-head {\n      margin-bottom: 12px;\n      display: flex;\n      align-items: center;\n      justify-content: flex-start;\n      gap: 10px;\n    }\n\n    .panel-head h3 {\n      margin: 0;\n      display: inline-flex;\n      align-items: center;\n      justify-content: flex-start;\n      gap: 10px;\n      font-size: 18px;\n      letter-spacing: -0.04em;\n    }\n\n    .panel-count {\n      flex: 0 0 auto;\n      min-width: 32px;\n      height: 32px;\n      padding: 0 10px;\n      margin-left: 2px;\n      border-radius: 999px;\n      display: inline-flex;\n      align-items: center;\n      justify-content: center;\n      font-size: 14px;\n      font-weight: 900;\n      background: rgba(148, 163, 184, 0.12);\n      color: #6b7280;\n      vertical-align: middle;\n      box-shadow: none;\n    }\n\n    .winner-panel .panel-count,\n    .quick-panel .panel-count {\n      background: var(--rose-soft);\n      color: rgba(15, 63, 53, 0.68);\n    }\n\n    .done-panel .panel-count {\n      background: rgba(148, 163, 184, 0.12);\n      color: #6b7280;\n    }\n\n    .ranking-panel .panel-count {\n      background: var(--violet-soft);\n      color: var(--violet);\n    }\n\n    .panel-head-actions {\n      margin-left: auto;\n      display: inline-flex;\n      align-items: center;\n      gap: 8px;\n    }\n\n    .panel-refresh-button {\n      border: 1px solid rgba(15, 23, 42, 0.08);\n      background: rgba(255, 255, 255, 0.72);\n      color: var(--ink);\n      min-height: 32px;\n      padding: 7px 12px;\n      border-radius: 999px;\n      font-size: 11px;\n      font-weight: 900;\n      letter-spacing: -0.02em;\n      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);\n    }\n\n    .panel-refresh-button:hover:not(:disabled) {\n      transform: translateY(-1px);\n      background: #fff;\n      box-shadow: 0 14px 30px rgba(15, 23, 42, 0.13);\n    }\n\n    .panel-refresh-button:disabled {\n      cursor: wait;\n      opacity: 0.68;\n      transform: none;\n    }\n\n    .panel h3 {\n      margin: 0 0 8px;\n      font-size: 18px;\n      letter-spacing: -0.04em;\n    }\n\n    .list {\n      display: grid;\n      gap: 6px;\n    }\n\n    .list-item {\n      display: grid;\n      grid-template-columns: auto 1fr auto;\n      gap: 6px;\n      align-items: center;\n      padding: 7px 9px;\n      border-radius: 16px;\n      background: var(--card-strong);\n      border: 1px solid rgba(17, 24, 39, 0.08);\n    }\n\n    .list-item-body {\n      min-width: 0;\n    }\n\n    .list-item.hotspot {\n      grid-template-columns: 1fr auto;\n    }\n\n    .index-badge {\n      width: 34px;\n      height: 34px;\n      border-radius: 50%;\n      display: grid;\n      place-items: center;\n      background: var(--violet-soft);\n      color: var(--violet);\n      font-size: 11px;\n      letter-spacing: 0.08em;\n      text-transform: uppercase;\n      font-weight: 900;\n    }\n\n    .index-badge.quick {\n      background: var(--blue-soft);\n      color: var(--blue);\n    }\n\n    .index-badge.winner {\n      background: var(--gold-soft);\n      color: var(--gold);\n    }\n\n    .index-badge.overdue {\n      box-shadow: inset 0 0 0 2px rgba(214, 75, 109, 0.2);\n    }\n\n    .queue-client-pill {\n      display: inline-flex;\n      align-items: center;\n      justify-content: center;\n      min-width: 74px;\n      min-height: 34px;\n      padding: 6px 10px;\n      border-radius: 999px;\n      background: var(--rose-soft);\n      color: var(--ink);\n      font-size: 9px;\n      font-weight: 800;\n      letter-spacing: 0.08em;\n      text-transform: uppercase;\n      white-space: normal;\n      line-height: 1.05;\n      text-align: center;\n      flex-shrink: 0;\n    }\n\n    .queue-client-pill.two-line {\n      padding-top: 7px;\n      padding-bottom: 7px;\n    }\n\n    .queue-client-pill.client-theme-mac88 {\n      background: rgba(50, 124, 240, 0.14);\n      color: #2563eb;\n    }\n\n    .queue-client-pill.client-theme-iconic21 {\n      background: rgba(121, 92, 246, 0.14);\n      color: #6d28d9;\n    }\n\n    .queue-client-pill.client-theme-digitain {\n      background: rgba(228, 116, 142, 0.14);\n      color: #c2416c;\n    }\n\n    .queue-client-pill.client-theme-enjoy-gaming {\n      background: rgba(41, 185, 121, 0.15);\n      color: #15803d;\n    }\n\n    .queue-client-pill.client-theme-amazing-gaming {\n      background: rgba(245, 158, 11, 0.16);\n      color: #b45309;\n    }\n\n    .queue-client-pill.client-theme-ballys {\n      background: rgba(240, 171, 0, 0.16);\n      color: #b45309;\n    }\n\n    .queue-client-pill.client-theme-mgasia {\n      background: rgba(16, 185, 129, 0.16);\n      color: #0f766e;\n    }\n\n    .queue-client-pill.client-theme-royal-gaming {\n      background: rgba(99, 102, 241, 0.14);\n      color: #4338ca;\n    }\n\n    .queue-client-pill.client-theme-stakelogic {\n      background: rgba(34, 197, 94, 0.14);\n      color: #15803d;\n    }\n\n    .queue-client-pill.client-theme-onetouch {\n      background: rgba(6, 182, 212, 0.14);\n      color: #0f766e;\n    }\n\n    .queue-client-pill.client-theme-animo {\n      background: rgba(100, 116, 139, 0.14);\n      color: #475569;\n    }\n\n    .queue-client-pill.client-theme-live-vegas {\n      background: rgba(132, 204, 22, 0.18);\n      color: #3f6212;\n    }\n\n    .queue-client-pill.client-theme-default {\n      background: rgba(17, 24, 39, 0.08);\n      color: var(--ink);\n    }\n\n    .list-item-title {\n      font-size: 15px;\n      font-weight: 800;\n      min-width: 0;\n      overflow-wrap: anywhere;\n      word-break: break-word;\n    }\n\n    .list-item-meta {\n      margin-top: 3px;\n      color: var(--muted);\n      font-size: 13px;\n      line-height: 1.35;\n    }\n\n    .list-item-count {\n      min-width: 58px;\n      padding: 7px 9px;\n      border-radius: 12px;\n      text-align: center;\n      font-size: 15px;\n      font-weight: 900;\n      background: var(--rose-soft);\n      color: rgba(15, 63, 53, 0.68);\n    }\n\n    .list-item-count.priority-fresh {\n      background: var(--blue-soft);\n      color: var(--blue);\n    }\n\n    .list-item-count.priority-2h {\n      background: var(--gold-soft);\n      color: var(--gold);\n    }\n\n    .list-item-count.priority-3h {\n      background: var(--rose-soft);\n      color: rgba(15, 63, 53, 0.68);\n    }\n\n    .list-item.hotspot .list-item-count {\n      background: var(--blue-soft);\n      color: var(--blue);\n    }\n\n    .queue-extra {\n      margin-top: 3px;\n      display: flex;\n      flex-wrap: wrap;\n      gap: 5px;\n    }\n\n    .queue-extra-chip {\n      display: inline-flex;\n      align-items: center;\n      gap: 5px;\n      padding: 4px 7px;\n      border-radius: 999px;\n      background: rgba(148, 163, 184, 0.12);\n      color: #6b7280;\n      font-size: 9px;\n      font-weight: 700;\n      line-height: 1.2;\n    }\n\n    .report-type-chip,\n    .report-status-chip {\n      display: inline-flex;\n      align-items: center;\n      gap: 5px;\n      padding: 5px 8px;\n      border-radius: 999px;\n      font-size: 11px;\n      font-weight: 800;\n      letter-spacing: 0.08em;\n      text-transform: uppercase;\n    }\n\n    .report-type-chip {\n      background: var(--gold-soft);\n      color: var(--gold);\n    }\n\n    .report-type-chip.quick {\n      background: var(--blue-soft);\n      color: var(--blue);\n    }\n\n    .report-type-chip.winner {\n      background: var(--gold-soft);\n      color: var(--gold);\n    }\n\n    .report-status-chip {\n      background: var(--rose-soft);\n      color: rgba(15, 63, 53, 0.68);\n    }\n\n    .report-status-chip.overdue {\n      background: var(--rose-soft);\n      color: rgba(15, 63, 53, 0.68);\n    }\n\n    .list-item.completed {\n      background: var(--green-soft);\n      border: 1px solid rgba(10, 163, 108, 0.28);\n    }\n\n    .list-item.completed .list-item-count {\n      background: rgba(255, 255, 255, 0.7);\n      color: var(--green);\n    }\n\n    .list-item.completed .queue-client-pill {\n      background: rgba(255, 255, 255, 0.6);\n      color: var(--green);\n    }\n\n    .panel-count-completed {\n      background: rgba(16, 185, 129, 0.16);\n      color: var(--green);\n    }\n\n    .completed-pdf-name {\n      display: inline-block;\n      max-width: min(100%, 520px);\n      overflow: hidden;\n      text-overflow: ellipsis;\n      white-space: nowrap;\n      vertical-align: middle;\n    }\n\n    .report-status-chip.done {\n      background: rgba(255, 255, 255, 0.7);\n      color: var(--green);\n    }\n\n    .client-card {\n      position: relative;\n      overflow: hidden;\n      background:\n        linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(255, 255, 255, 0.84));\n    }\n\n    .client-card::before {\n      content: \"\";\n      position: absolute;\n      inset: 0 0 auto 0;\n      height: 8px;\n      background: linear-gradient(90deg, var(--green), var(--blue), var(--violet));\n      opacity: 0.9;\n    }\n\n    .client-card.zero::before {\n      background: linear-gradient(90deg, #b8bdb9, #d8ddd9) !important;\n      opacity: 0.72;\n    }\n    .client-card.client-theme-mac88::before { background: linear-gradient(90deg, #2563eb, #60a5fa); }\n    .client-card.client-theme-iconic21::before { background: linear-gradient(90deg, #6d28d9, #a78bfa); }\n    .client-card.client-theme-digitain::before { background: linear-gradient(90deg, #c2416c, #f472b6); }\n    .client-card.client-theme-enjoy-gaming::before { background: linear-gradient(90deg, #15803d, #4ade80); }\n    .client-card.client-theme-amazing-gaming::before { background: linear-gradient(90deg, #b45309, #f59e0b); }\n    .client-card.client-theme-ballys::before { background: linear-gradient(90deg, #d97706, #fbbf24); }\n    .client-card.client-theme-mgasia::before { background: linear-gradient(90deg, #0f766e, #2dd4bf); }\n    .client-card.client-theme-royal-gaming::before { background: linear-gradient(90deg, #4338ca, #818cf8); }\n    .client-card.client-theme-stakelogic::before { background: linear-gradient(90deg, #15803d, #86efac); }\n    .client-card.client-theme-onetouch::before { background: linear-gradient(90deg, #0f766e, #67e8f9); }\n    .client-card.client-theme-animo::before { background: linear-gradient(90deg, #991b1b, #fca5a5); }\n    .client-card.client-theme-live-vegas::before { background: linear-gradient(90deg, #4d7c0f, #bef264); }\n    .client-card.client-theme-default::before { background: linear-gradient(90deg, var(--green), var(--blue), var(--violet)); }\n\n    .client-card.client-theme-enjoy-gaming .client-name {\n      max-width: 6ch;\n      line-height: 0.92;\n    }\n\n    .client-head {\n      display: flex;\n      justify-content: space-between;\n      gap: 12px;\n      align-items: flex-start;\n      margin-top: 8px;\n      margin-bottom: 16px;\n    }\n\n    .client-head > div:first-child {\n      min-width: 0;\n      flex: 1 1 auto;\n    }\n\n\n    .client-name {\n      font-size: 24px;\n      line-height: 1;\n      font-weight: 900;\n      letter-spacing: -0.05em;\n    }\n\n    .client-head-actions {\n      display: flex;\n      align-items: center;\n      justify-content: flex-end;\n      gap: 6px;\n      margin-left: auto;\n      flex: 0 0 auto;\n    }\n    .client-total,\n    .winner-badge,\n    .quick-badge {\n      min-width: 58px;\n      padding: 7px 9px;\n      border-radius: 15px;\n      display: inline-flex;\n      align-items: center;\n      justify-content: center;\n      gap: 5px;\n      font-size: 22px;\n      font-weight: 900;\n      background: var(--rose-soft);\n      color: rgba(15, 63, 53, 0.68);\n    }\n    .winner-badge {\n      min-width: 44px;\n      padding: 7px 9px;\n      font-size: 16px;\n      background: var(--gold-soft);\n      color: var(--gold);\n    }\n\n    .quick-badge {\n      min-width: 44px;\n      padding: 7px 9px;\n      font-size: 16px;\n      background: var(--blue-soft);\n      color: var(--blue);\n    }\n\n    .badge-prefix {\n      font-size: 11px;\n      font-weight: 900;\n      letter-spacing: 0.14em;\n      text-transform: uppercase;\n      opacity: 0.78;\n    }\n\n    .client-card.zero {\n      background: linear-gradient(180deg, rgba(249, 250, 250, 0.94), rgba(243, 245, 245, 0.9));\n      border-color: rgba(148, 163, 184, 0.14);\n      box-shadow: 0 12px 28px rgba(148, 163, 184, 0.06);\n    }\n\n    .client-card.zero .client-head,\n    .client-card.zero .client-meta-bar,\n    .client-card.zero .tab-list {\n      opacity: 0.62;\n    }\n\n    .client-card.zero .label,\n    .client-card.zero .client-name,\n    .client-card.zero .clear-state,\n    .client-card.zero .tab-label {\n      color: #8b938d;\n    }\n    .client-card.zero .client-refresh-button {\n      background: rgba(248, 250, 252, 0.88);\n      border-color: rgba(148, 163, 184, 0.16);\n      color: #98a19a;\n      box-shadow: none;\n    }\n\n    .client-card.zero .mini-chip,\n    .client-card.zero .winner-badge,\n    .client-card.zero .quick-badge,\n    .client-card.zero .reports-chip,\n    .client-card.zero .client-total {\n      background: rgba(148, 163, 184, 0.09);\n      color: #8a918b;\n      border-color: rgba(148, 163, 184, 0.08);\n    }\n    .client-card.zero .tab-row {\n      background: rgba(250, 251, 252, 0.82);\n      border-color: rgba(148, 163, 184, 0.08);\n    }\n\n    .client-card.zero .tab-count {\n      background: rgba(148, 163, 184, 0.09);\n      color: #8a918b;\n      border-color: rgba(148, 163, 184, 0.08);\n    }\n    .client-refresh-button {\n      width: 38px;\n      height: 38px;\n      padding: 0;\n      border-radius: 999px;\n      display: inline-grid;\n      place-items: center;\n      background: rgba(255, 255, 255, 0.92);\n      border: 1px solid rgba(17, 24, 39, 0.1);\n      color: var(--ink);\n      font-size: 15px;\n      line-height: 1;\n      box-shadow: 0 8px 20px rgba(17, 24, 39, 0.08);\n    }\n\n    .client-refresh-button:disabled {\n      cursor: wait;\n      opacity: 0.65;\n    }\n\n    .client-meta-bar {\n      display: flex;\n      flex-wrap: wrap;\n      gap: 6px;\n      margin-bottom: 14px;\n    }\n\n    .mini-chip {\n      padding: 7px 10px;\n      border-radius: 999px;\n      background: rgba(148, 163, 184, 0.12);\n      color: #6b7280;\n      font-size: 11px;\n      font-weight: 700;\n      letter-spacing: 0.06em;\n      text-transform: uppercase;\n    }\n\n    .mini-chip-quick {\n      background: var(--blue-soft);\n      color: var(--blue);\n    }\n\n    .mini-chip-winner {\n      background: var(--gold-soft);\n      color: var(--gold);\n    }\n\n    .tab-list {\n      display: grid;\n      gap: 6px;\n    }\n\n    .tab-row {\n      display: grid;\n      grid-template-columns: 1fr auto;\n      gap: 6px;\n      align-items: center;\n      padding: 7px 9px;\n      border-radius: 12px;\n      background: rgba(17, 24, 39, 0.045);\n    }\n\n    .tab-label {\n      line-height: 1.35;\n      color: #2d3644;\n      font-size: 13px;\n    }\n\n    .tab-count {\n      min-width: 38px;\n      padding: 6px 10px;\n      border-radius: 999px;\n      border: 1px solid rgba(17, 24, 39, 0.09);\n      background: #fff;\n      text-align: center;\n      font-weight: 800;\n    }\n\n    .clear-state {\n      color: var(--muted);\n      line-height: 1.5;\n      font-size: 13px;\n      padding: 10px 0 4px;\n    }\n\n    .footer-note {\n      color: var(--muted);\n      line-height: 1.6;\n      background: rgba(255, 255, 255, 0.72);\n    }\n\n    .error {\n      margin-top: 16px;\n      padding: 14px 16px;\n      border-radius: 16px;\n      background: rgba(214, 129, 28, 0.12);\n      color: #85521a;\n      line-height: 1.5;\n    }\n\n    .busy-note {\n      margin-top: 10px;\n      color: rgba(15, 63, 53, 0.78);\n      line-height: 1.5;\n    }\n\n    @media (max-width: 1240px) {\n      .login-card,\n      .hero-main {\n        grid-template-columns: 1fr;\n      }\n\n      .panel-grid {\n        grid-template-columns: repeat(2, minmax(0, 1fr));\n      }\n\n      .queue-grid {\n        grid-template-columns: repeat(2, minmax(0, 1fr));\n      }\n\n      .dashboard-board {\n        grid-template-columns: repeat(2, minmax(0, 1fr));\n      }\n\n      .board-item.span-4 {\n        grid-column: span 2;\n      }\n\n      .summary-grid,\n      .client-section {\n        grid-template-columns: repeat(2, minmax(0, 1fr));\n      }\n    }\n\n    body[data-layout=\"portrait\"] .app {\n      width: min(100vw - 18px, 1240px);\n      margin: 8px auto 18px;\n    }\n\n    body[data-layout=\"portrait\"] .hero,\n    body[data-layout=\"portrait\"] .panel,\n    body[data-layout=\"portrait\"] .summary-card,\n    body[data-layout=\"portrait\"] .client-card,\n    body[data-layout=\"portrait\"] .footer-note,\n    body[data-layout=\"portrait\"] .login-form,\n    body[data-layout=\"portrait\"] .login-side {\n      border-radius: 24px;\n    }\n\n    body[data-layout=\"portrait\"] .hero {\n      padding: 12px 13px;\n    }\n\n    body[data-layout=\"portrait\"] .hero-main {\n      grid-template-columns: 1.15fr 0.85fr;\n      gap: 5px;\n      align-items: center;\n    }\n\n    body[data-layout=\"portrait\"] .hero h2 {\n      max-width: 10ch;\n      margin-bottom: 4px;\n      font-size: clamp(25px, 3.3vw, 38px);\n    }\n\n    body[data-layout=\"portrait\"] .hero p {\n      max-width: none;\n      font-size: 11px;\n      line-height: 1.4;\n    }\n\n    body[data-layout=\"portrait\"] .hero-side {\n      grid-template-columns: 1fr;\n      gap: 5px;\n    }\n\n    body[data-layout=\"portrait\"] .hero-stat {\n      padding: 7px 9px;\n    }\n\n    body[data-layout=\"portrait\"] .hero-stat strong {\n      font-size: 18px;\n      margin-bottom: 4px;\n    }\n\n    body[data-layout=\"portrait\"] .hero-stat span {\n      font-size: 11px;\n    }\n\n    body[data-layout=\"portrait\"] .toolbar {\n      margin-top: 8px;\n      gap: 5px;\n    }\n\n    body[data-layout=\"portrait\"] .toolbar-right {\n      width: 100%;\n      justify-content: flex-start;\n    }\n\n    body[data-layout=\"portrait\"] .date-controls {\n      flex: 1 1 100%;\n    }\n\n    body[data-layout=\"portrait\"] .quick-date-actions {\n      gap: 5px;\n    }\n\n    body[data-layout=\"portrait\"] .date-input,\n    body[data-layout=\"portrait\"] .ghost-button,\n    body[data-layout=\"portrait\"] .secondary,\n    body[data-layout=\"portrait\"] .primary {\n      padding: 9px 11px;\n      border-radius: 12px;\n      font-size: 13px;\n    }\n\n    body[data-layout=\"portrait\"] .hero-bottom {\n      gap: 5px;\n      justify-content: flex-start;\n    }\n\n    body[data-layout=\"portrait\"] .chip,\n    body[data-layout=\"portrait\"] .pill,\n    body[data-layout=\"portrait\"] .status-badge,\n    body[data-layout=\"portrait\"] .mini-chip {\n      font-size: 11px;\n    }\n\n    body[data-layout=\"portrait\"] .summary-grid {\n      grid-template-columns: repeat(4, minmax(0, 1fr));\n    }\n\n    body[data-layout=\"portrait\"] .client-section {\n      grid-template-columns: repeat(3, minmax(0, 1fr));\n    }\n\n    body[data-layout=\"portrait\"] .summary-card,\n    body[data-layout=\"portrait\"] .panel,\n    body[data-layout=\"portrait\"] .client-card,\n    body[data-layout=\"portrait\"] .footer-note {\n      padding: 14px;\n    }\n\n    body[data-layout=\"portrait\"] .value {\n      margin-top: 8px;\n      font-size: clamp(22px, 3.3vw, 34px);\n    }\n\n    body[data-layout=\"portrait\"] .subvalue {\n      margin-top: 6px;\n      font-size: 13px;\n    }\n\n    body[data-layout=\"portrait\"] .client-name {\n      font-size: 16px;\n    }\n\n    body[data-layout=\"portrait\"] .client-total,\n    body[data-layout=\"portrait\"] .winner-badge {\n      min-width: 42px;\n      padding: 7px 8px;\n      font-size: 16px;\n    }\n\n    body[data-layout=\"portrait\"] .panel-grid {\n      grid-template-columns: repeat(2, minmax(0, 1fr));\n    }\n\n    body[data-layout=\"portrait\"] .queue-grid {\n      grid-template-columns: repeat(2, minmax(0, 1fr));\n    }\n\n    body[data-layout=\"portrait\"] .panel h3 {\n      font-size: 19px;\n    }\n\n    body[data-layout=\"portrait\"] .client-head {\n      margin-top: 3px;\n      margin-bottom: 10px;\n    }\n\n    body[data-layout=\"portrait\"] .client-meta-bar {\n      gap: 5px;\n      margin-bottom: 10px;\n    }\n\n    body[data-layout=\"portrait\"] .tab-list {\n      gap: 6px;\n    }\n\n    body[data-layout=\"portrait\"] .tab-row {\n      gap: 6px;\n      padding: 7px 9px;\n    }\n\n    body[data-layout=\"portrait\"] .tab-label,\n    body[data-layout=\"portrait\"] .clear-state {\n      font-size: 11px;\n    }\n\n    body[data-layout=\"portrait\"] .tab-count {\n      min-width: 30px;\n      padding: 4px 8px;\n      font-size: 11px;\n    }\n\n    body[data-layout=\"portrait\"] .label {\n      font-size: 9px;\n    }\n\n    body[data-layout=\"portrait\"] .list {\n      gap: 6px;\n    }\n\n    body[data-layout=\"portrait\"] .list-item {\n      padding: 7px 9px;\n      gap: 6px;\n    }\n\n    body[data-layout=\"portrait\"] .list-item-title {\n      font-size: 13px;\n    }\n\n    body[data-layout=\"portrait\"] .list-item-meta {\n      font-size: 11px;\n    }\n\n    @media (orientation: portrait) and (min-width: 900px) {\n      .app {\n        width: min(100vw - 18px, 1240px);\n        margin: 8px auto 18px;\n      }\n\n      .hero,\n      .panel,\n      .summary-card,\n      .client-card,\n      .footer-note,\n      .login-form,\n      .login-side {\n        border-radius: 24px;\n      }\n\n      .hero {\n        padding: 12px 13px;\n      }\n\n      .hero-main {\n        grid-template-columns: 1.15fr 0.85fr;\n        gap: 5px;\n        align-items: center;\n      }\n\n      .hero h2 {\n        max-width: 10ch;\n        margin-bottom: 4px;\n        font-size: clamp(25px, 3.3vw, 38px);\n      }\n\n      .hero p {\n        max-width: none;\n        font-size: 11px;\n        line-height: 1.4;\n      }\n\n      .hero-side {\n        grid-template-columns: 1fr;\n        gap: 5px;\n      }\n\n      .hero-stat {\n        padding: 7px 9px;\n      }\n\n      .hero-stat strong {\n        font-size: 18px;\n        margin-bottom: 4px;\n      }\n\n      .hero-stat span {\n        font-size: 11px;\n      }\n\n      .toolbar {\n        margin-top: 8px;\n        gap: 5px;\n      }\n\n      .toolbar-right {\n        width: 100%;\n        justify-content: flex-start;\n      }\n\n      .date-controls {\n        flex: 1 1 100%;\n      }\n\n      .quick-date-actions {\n        gap: 5px;\n      }\n\n      .date-input,\n      .ghost-button,\n      .secondary,\n      .primary {\n        padding: 9px 11px;\n        border-radius: 12px;\n        font-size: 13px;\n      }\n\n      .hero-bottom {\n        gap: 5px;\n        justify-content: flex-start;\n      }\n\n      .chip,\n      .pill,\n      .status-badge,\n      .mini-chip {\n        font-size: 11px;\n      }\n\n      .summary-grid {\n        grid-template-columns: repeat(4, minmax(0, 1fr));\n      }\n\n      .client-section {\n        grid-template-columns: repeat(3, minmax(0, 1fr));\n      }\n\n      .summary-card,\n      .panel,\n      .client-card,\n      .footer-note {\n        padding: 14px;\n      }\n\n      .value {\n        margin-top: 8px;\n        font-size: clamp(22px, 3.3vw, 34px);\n      }\n\n      .subvalue {\n        margin-top: 6px;\n        font-size: 13px;\n      }\n\n      .client-name {\n        font-size: 16px;\n      }\n\n      .client-total,\n      .winner-badge {\n        min-width: 42px;\n        padding: 7px 8px;\n        font-size: 16px;\n      }\n\n      .panel-grid {\n        grid-template-columns: repeat(2, minmax(0, 1fr));\n      }\n\n      .queue-grid {\n        grid-template-columns: repeat(2, minmax(0, 1fr));\n      }\n\n      .panel h3 {\n        font-size: 19px;\n      }\n\n      .client-head {\n        margin-top: 3px;\n        margin-bottom: 10px;\n      }\n\n      .client-meta-bar {\n        gap: 5px;\n        margin-bottom: 10px;\n      }\n\n      .tab-list {\n        gap: 6px;\n      }\n\n      .tab-row {\n        gap: 6px;\n        padding: 7px 9px;\n      }\n\n      .tab-label,\n      .clear-state {\n        font-size: 11px;\n      }\n\n      .tab-count {\n        min-width: 30px;\n        padding: 4px 8px;\n        font-size: 11px;\n      }\n\n      .label {\n        font-size: 9px;\n      }\n\n      .list {\n        gap: 6px;\n      }\n\n      .list-item {\n        padding: 7px 9px;\n        gap: 6px;\n      }\n\n      .list-item-title {\n        font-size: 13px;\n      }\n\n      .list-item-meta {\n        font-size: 11px;\n      }\n    }\n\n    @media (max-width: 760px) {\n      .app {\n        width: min(100vw - 20px, 100%);\n        margin: 10px auto 24px;\n      }\n\n      .dashboard-board {\n        grid-template-columns: 1fr;\n      }\n\n      .queue-grid {\n        grid-template-columns: 1fr;\n      }\n\n      .panel-grid {\n        grid-template-columns: 1fr;\n      }\n\n      .board-item.span-4,\n      .board-item.span-2,\n      .board-item.span-1 {\n        grid-column: span 1;\n      }\n\n      .summary-grid,\n      .client-section {\n        grid-template-columns: 1fr;\n      }\n\n      .login-form,\n      .login-side,\n      .hero,\n      .panel,\n      .summary-card,\n      .client-card,\n      .footer-note {\n        padding: 18px;\n      }\n\n      .login-card,\n      .hero,\n      .panel,\n      .summary-card,\n      .client-card,\n      .login-card {\n        border-radius: 18px;\n      }\n    }\n\n/* ---- bookmarklet host additions ---- */\n.bm-mini {\n  position: fixed;\n  right: 16px;\n  bottom: 16px;\n  z-index: 50;\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  background: #043927;\n  color: #EFFFFB;\n  padding: 10px 18px;\n  border-radius: 999px;\n  font: 700 13px \"Segoe UI\", system-ui, sans-serif;\n  box-shadow: 0 12px 30px rgba(0, 0, 0, .28);\n  cursor: pointer;\n  border: 1px solid rgba(239, 255, 251, .18);\n}\n.bm-mini b { font-size: 19px; color: #7CE3C3; }\n.bm-mini span.bm-mini-note { font-weight: 600; opacity: .75; }\n.bm-topbar {\n  position: sticky;\n  top: 0;\n  z-index: 40;\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 10px;\n  padding: 10px 18px;\n  background: #043927;\n  color: #EFFFFB;\n  font: 700 13px \"Segoe UI\", system-ui, sans-serif;\n  box-shadow: 0 8px 24px rgba(4, 57, 39, .25);\n  margin: 0 auto;\n  width: min(1500px, calc(100vw - 40px));\n  border-radius: 0 0 16px 16px;\n}\n.bm-topbar .bm-topbar-actions { display: flex; gap: 6px; }\n.bm-topbar button {\n  border: 1px solid rgba(239, 255, 251, .25);\n  background: rgba(239, 255, 251, .1);\n  color: #EFFFFB;\n  border-radius: 10px;\n  padding: 6px 12px;\n  font: 700 12px/1 \"Segoe UI\", system-ui, sans-serif;\n  cursor: pointer;\n}\n.bm-topbar button:disabled { opacity: .5; cursor: default; }\n.bm-version { color: #7CE3C3; font-size: 11px; margin-left: 6px; }\r\n";

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
  let originalClientId = null;
  let statusLine = "Ready. Press Scan.";
  let selectedDateIso = getIsoDate();
  let completedReportsExpanded = false;
  let requestNotificationsEnabled = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) === "1";
  let lastRequestsTotal = null;
  let minimized = false;
  const statusProgress = { inProgress: false, processedClients: 0, totalClients: 0, currentClient: null, currentStage: null };
  const winnerProgress = { inProgress: false, processedClients: 0, totalClients: 0, currentClient: null, currentStage: null };
  const refreshingClientIds = new Set();

  const host = document.createElement("div");
  host.id = PANEL_ID;
  host.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483000",
    "overflow:auto",
    "background:radial-gradient(circle at top left, rgba(10,163,108,.12), transparent 25%), radial-gradient(circle at top right, rgba(106,70,242,.16), transparent 28%), linear-gradient(180deg,#fbf7f0 0%, #f6f1e8 55%, #ece2cf 100%)",
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
      shadow.innerHTML = `<style>${DASHBOARD_CSS}</style>
        <div class="bm-mini" id="bm-mini">
          BO Checklist<span class="bm-version">${escapeHtml(VERSION)}</span>
          <span class="bm-mini-note">Pending players:</span><b>${escapeHtml(pendingPlayers)}</b>
          <span class="bm-mini-note">Click to open</span>
        </div>`;
      shadow.getElementById("bm-mini").addEventListener("click", () => {
        minimized = false;
        render(currentPayload);
      });
      return;
    }

    const visibleData = applyNightOnlyFilter(payload || { clients: [], warnings: [] });
    const clients = [...(visibleData.clients || [])].sort((a, b) => b.total - a.total || a.client.localeCompare(b.client));
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

    shadow.innerHTML = `<style>${DASHBOARD_CSS}</style>
      <div class="bm-topbar">
        <div>BO Checklist <span class="bm-version">${escapeHtml(VERSION)}</span>${extra.progressLine ? ` <span style="opacity:.75;font-weight:600;">${escapeHtml(extra.progressLine)}</span>` : ""}</div>
        <div class="bm-topbar-actions">
          <button type="button" id="bm-minimize">Minimize</button>
          <button type="button" id="bm-close">Close</button>
        </div>
      </div>
      <div class="app">
        <section class="hero">
          <div class="hero-top">
            <div class="pill" style="background:rgba(255,255,255,0.16); color:#fff; border:1px solid rgba(255,255,255,0.18);">Worker session active</div>
            <div class="status-badge">BO Checklist ${escapeHtml(VERSION)}</div>
          </div>

          <div class="hero-main">
            <div class="hero-copy">
              <h2>One screen. All unchecked.</h2>
              <p>
                This dashboard runs on your logged-in BO tab, then pulls today's unchecked tab badges automatically and keeps the whole review picture on one screen.
              </p>
            </div>
            <div class="hero-side">
              <div class="hero-stat">
                <strong>${escapeHtml(totalUnchecked)}</strong>
                <span>Total unchecked cases across all visible clients.</span>
              </div>
              <div class="hero-stat">
                <strong>${escapeHtml(heroLeadTitle)}</strong>
                <span>${escapeHtml(heroLeadText)}</span>
              </div>
              <div class="hero-stat" role="status">
                <strong>Requests: ${escapeHtml(requestsLabel)}</strong>
                <span>Ticketing · updates approximately every 5 minutes</span>
                <button class="ghost-button" type="button" id="requests-notifications" style="margin-top:6px;padding:5px 9px;font-size:11px;align-self:flex-start;">${requestNotificationsEnabled && "Notification" in window && Notification.permission === "granted" ? "Disable request notifications" : "Enable request notifications"}</button>
              </div>
            </div>
          </div>

          <div class="toolbar">
            <div class="hero-bottom">
              <div class="chip">${escapeHtml(activeClients.length)} clients need review</div>
              <div class="chip">${escapeHtml(idleClients.length)} clients are clear</div>
              <div class="chip" id="last-update-chip">${escapeHtml(lastUpdatedText)}</div>
              <div class="chip" id="winner-update-chip">${escapeHtml(winnerChipText)}</div>
              <div class="chip" id="winner-next-chip">${escapeHtml(winnerNextText)}</div>
            </div>
            <div class="toolbar-right">
              <div class="date-controls">
                <input class="date-input" id="date-filter" type="date" value="${escapeHtml(selectedDateIso)}">
                <div class="quick-date-actions">
                  <button class="ghost-button" id="today-button" type="button">Today</button>
                  <button class="ghost-button" id="yesterday-button" type="button">Yesterday</button>
                  <button class="secondary" id="apply-date-button" type="button">Apply date</button>
                  <button class="ghost-button" id="night-toggle-button" type="button">${ignoreNightOnly ? "Include night tabs" : "Hide night tabs"}</button>
                </div>
              </div>
              <div class="actions" style="margin:0;">
                <button class="primary" id="refresh-button" type="button" ${isScanningStatus ? "disabled" : ""}>${isScanningStatus ? "Loading..." : "Refresh now"}</button>
                <button class="ghost-button" id="winner-refresh-button" type="button" ${isScanningWinner ? "disabled" : ""}>${isScanningWinner ? "Loading winner..." : "Refresh winner reports"}</button>
              </div>
            </div>
          </div>

          ${warnings}
        </section>

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

                <div class="client-meta-bar">
                  <div class="mini-chip">Open tabs ${escapeHtml(client.nonZero.length)}</div>
                  ${showQuickReports ? `<div class="mini-chip mini-chip-quick" data-quick-left="1">Quick left ${quickReportsDisplay}</div>` : ""}
                  <div class="mini-chip" data-winner-done="1">Winner done ${client.winnerReportsCompleted == null ? "-" : escapeHtml(client.winnerReportsCompleted)}</div>
                  <div class="mini-chip" data-reports-total="1">Reports total ${client.winnerReportsTotal == null ? "-" : escapeHtml(client.winnerReportsTotal)}</div>
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
                  <div class="list-item mailing-item">
                    ${renderQueueClientPill(client.client || "Client")}
                    <div class="list-item-body">
                      <div class="list-item-title">${escapeHtml(client.client || "Client")}</div>
                      <div class="queue-extra">
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

          <article class="panel">
            <h3>Backlog ranking</h3>
            <div class="list">
              ${activeClients.slice(0, 6).map((client, index) => `
                <div class="list-item">
                  <div class="index-badge">${index + 1}</div>
                  <div class="hero-copy">
                    <div class="list-item-title">${escapeHtml(client.client)}</div>
                    <div class="list-item-meta">${escapeHtml(client.nonZero.map((item) => `${item.label} ${item.count}`).join(" | "))}</div>
                  </div>
                  <div class="list-item-count">${escapeHtml(client.total)}</div>
                </div>
              `).join("") || `<div class="list-item"><div class="hero-copy"><div class="list-item-title">Nothing unchecked</div><div class="list-item-meta">All visible clients are currently clear.</div></div><div class="list-item-count">0</div></div>`}
            </div>
          </article>

          <article class="panel">
            <h3>Biggest hotspots</h3>
            <div class="list">
              ${hotspots.map((item) => `
                <div class="list-item hotspot">
                  <div class="hero-copy">
                    <div class="list-item-title">${escapeHtml(item.label)}</div>
                    <div class="list-item-meta">${escapeHtml(item.clients.join(", "))}</div>
                  </div>
                  <div class="list-item-count">${escapeHtml(item.count)}</div>
                </div>
              `).join("") || `<div class="list-item hotspot"><div class="hero-copy"><div class="list-item-title">No hotspots</div><div class="list-item-meta">No active checklist pressure in the current BO snapshot.</div></div><div class="list-item-count">0</div></div>`}
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
    `;

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
