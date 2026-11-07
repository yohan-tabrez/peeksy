(() => {
  'use strict';

  // Re-injection after extension reload must replace dead listeners.
  // Abort any previous install in this frame instead of bailing out forever.
  if (window.__peeksyAbort) {
    try { window.__peeksyAbort.abort(); } catch { /* ignore */ }
  }
  const installAbort = new AbortController();
  window.__peeksyAbort = installAbort;
  const installSignal = installAbort.signal;

  const Settings = globalThis.PeeksySettings;
  if (!Settings) return;

  // Only one live copy per frame. After an extension reload the old copy can
  // survive in a different JS world (with a dead extension connection) and keep
  // reacting to clicks, so every copy listens for this DOM event — which all
  // worlds share — and shuts down when a newer copy announces itself.
  const TAKEOVER_EVENT = 'peeksy:takeover';
  const INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  document.addEventListener(TAKEOVER_EVENT, (e) => {
    if (e.detail !== INSTANCE_ID) installAbort.abort();
  }, { signal: installSignal });
  document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT, { detail: INSTANCE_ID }));

  const IS_TOP = window === window.top;
  // Set when the background tells this frame it is the open preview (it tracks
  // the preview frame with webNavigation). Nothing about the frame itself is
  // marked, so the previewed page can't see or react to Peeksy.
  let previewToken = null;

  // ─── Extension plumbing ──────────────────────────────────────────────────────

  function extensionAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  /** @param {object} msg @returns {Promise<any>} never rejects */
  function sendMessage(msg) {
    return new Promise((resolve) => {
      if (!extensionAlive()) {
        resolve({ ok: false, error: 'Extension context invalidated' });
        return;
      }
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res ?? { ok: false });
        });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  }

  // ─── Settings ────────────────────────────────────────────────────────────────

  let settings = Settings.normalize();

  if (extensionAlive()) {
    Settings.load().then((s) => { settings = s; }, () => {});
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== Settings.AREA || installSignal.aborted) return;
        const next = { ...settings };
        for (const [key, { newValue }] of Object.entries(changes)) {
          if (key in Settings.DEFAULTS) next[key] = newValue;
        }
        settings = Settings.normalize(next);
      });
    } catch { /* context invalidated */ }
  }

  /** Host of the page the user is looking at (the top frame), for per-site disabling. */
  function pageHost() {
    if (IS_TOP) return location.hostname;
    try {
      const origins = location.ancestorOrigins;
      if (origins?.length) return new URL(origins[origins.length - 1]).hostname;
    } catch { /* ignore */ }
    try {
      return window.top.location.hostname;
    } catch {
      return location.hostname;
    }
  }

  /** A copy whose extension was reloaded/removed retires itself on first use. */
  function alive() {
    if (installSignal.aborted) return false;
    if (extensionAlive()) return true;
    installAbort.abort();
    return false;
  }

  function activeHere() {
    return alive() && settings.enabled && !Settings.isSiteDisabled(pageHost(), settings.disabledSites);
  }

  // ─── Link helpers ────────────────────────────────────────────────────────────

  function isPreviewable(url) {
    if (!url) return false;
    try {
      const { protocol } = new URL(url);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }

  /** @param {Element} el */
  function linkUrlOf(el) {
    const tag = el.localName;
    if (tag !== 'a' && tag !== 'area') return undefined;
    const href = el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (!href) return undefined;
    try {
      const url = new URL(href, el.baseURI || document.baseURI).href;
      return isPreviewable(url) ? url : null;
    } catch {
      return null;
    }
  }

  /** Link URL under an event — handles SVG links, image maps and open shadow trees. */
  function linkFromEvent(e) {
    for (const node of e.composedPath()) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const url = linkUrlOf(node);
      if (url !== undefined) return url;
    }
    return null;
  }

  function focusedLinkUrl() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    for (let n = el; n; n = n.parentNode || n.host) {
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const url = linkUrlOf(n);
      if (url !== undefined) return url;
    }
    return null;
  }

  function matchesTrigger(e) {
    switch (settings.triggerKey) {
      case 'altShift': return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
      case 'altCtrl':  return e.altKey && e.ctrlKey && !e.shiftKey && !e.metaKey;
      default:         return e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey;
    }
  }

  /** @param {string} url @param {'click'|'hover'|'key'} source */
  function requestPreview(url, source) {
    if (IS_TOP) showPreview(url, source);
    else sendMessage({ type: 'openPreview', url, source });
  }

  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  // ─── Trigger: modifier + click ───────────────────────────────────────────────
  // mousedown (not click) so Chrome's native Alt+click "Save link as" never fires.
  // Window capture phase runs before any page listener.

  let suppressClickUntil = 0; // modifiers may be released before mouseup

  window.addEventListener('mousedown', (e) => {
    cancelHover();
    if (e.button !== 0 || !matchesTrigger(e) || !activeHere()) return;
    const url = linkFromEvent(e);
    if (!url) return;
    swallow(e);
    suppressClickUntil = e.timeStamp + 1500;
    requestPreview(url, 'click');
  }, { capture: true, signal: installSignal });

  window.addEventListener('click', (e) => {
    const suppressed = e.timeStamp < suppressClickUntil;
    suppressClickUntil = 0;
    if (!linkFromEvent(e)) return;
    if (suppressed || (matchesTrigger(e) && activeHere())) swallow(e);
  }, { capture: true, signal: installSignal });

  // ─── Trigger: hover (optional) ───────────────────────────────────────────────

  let hoverTimer = 0;
  let hoverUrl = null;

  function cancelHover() {
    clearTimeout(hoverTimer);
    hoverTimer = 0;
    hoverUrl = null;
  }

  window.addEventListener('mouseover', (e) => {
    if (!settings.hoverPreview || previewToken || (IS_TOP && activeOverlay) || !activeHere()) {
      cancelHover();
      return;
    }
    const url = linkFromEvent(e);
    if (url === hoverUrl) return;
    cancelHover();
    if (!url) return;
    hoverUrl = url;
    hoverTimer = setTimeout(() => {
      const target = hoverUrl;
      cancelHover();
      if (target) requestPreview(target, 'hover');
    }, settings.hoverDelay);
  }, { capture: true, passive: true, signal: installSignal });

  window.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget) cancelHover(); // pointer left the window
  }, { capture: true, passive: true, signal: installSignal });

  for (const type of ['keydown', 'wheel', 'blur']) {
    window.addEventListener(type, cancelHover, { capture: true, passive: true, signal: installSignal });
  }

  // ─── Runtime messages ────────────────────────────────────────────────────────

  function onRuntimeMessage(msg, sender, sendResponse) {
    if (installSignal.aborted || sender.id !== chrome.runtime.id) return false;
    switch (msg?.type) {
      case 'showPreview':
        if (!IS_TOP) return false;
        if (msg.source === 'hover' && activeOverlay) {
          sendResponse({ ok: false });
        } else {
          showPreview(msg.url, msg.source);
          sendResponse({ ok: true });
        }
        return false;

      case 'frameEvent':
        if (IS_TOP && activeOverlay) activeOverlay.onFrameEvent(msg);
        return false;

      case 'command': {
        if (!IS_TOP) return false;
        if (activeOverlay) {
          activeOverlay.close();
          sendResponse({ handled: true });
          return false;
        }
        const url = document.hasFocus() ? focusedLinkUrl() : null;
        if (url) showPreview(url, 'key');
        sendResponse({ handled: Boolean(url) });
        return false;
      }

      case 'previewFocusedLink':
        if (!IS_TOP && document.hasFocus()) {
          const url = focusedLinkUrl();
          if (url) requestPreview(url, 'key');
        }
        return false;

      case 'frameCommand':
        if (previewToken && msg.token === previewToken) runFrameCommand(msg.cmd);
        return false;

      case 'previewHello':
        if (!IS_TOP && typeof msg.token === 'string') becomePreview(msg.token);
        return false;

      default:
        return false;
    }
  }

  try {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    installSignal.addEventListener('abort', () => {
      try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* ignore */ }
    });
  } catch { /* context invalidated */ }

  // ─── Inside the preview iframe ───────────────────────────────────────────────
  // Reports "this document loaded" (the reliable embed-success signal), the
  // current URL/title for the toolbar, and forwards Escape to the overlay.

  function runFrameCommand(cmd) {
    const nav = window.navigation;
    if (!nav) return;
    if (cmd === 'back' && nav.canGoBack) nav.back();
    if (cmd === 'forward' && nav.canGoForward) nav.forward();
  }

  function becomePreview(token) {
    if (previewToken) return; // already set up for this document
    previewToken = token;
    cancelHover();
    let lastState = '';
    const report = (event) => {
      const nav = window.navigation;
      const state = {
        url: location.href,
        title: document.title || '',
        canGoBack: Boolean(nav?.canGoBack),
        canGoForward: Boolean(nav?.canGoForward),
      };
      const key = JSON.stringify(state);
      if (event === 'nav' && key === lastState) return;
      lastState = key;
      sendMessage({ type: 'frameEvent', token: previewToken, event, ...state });
    };

    // Keep scrolling inside the preview from chaining to the page behind it.
    const containScroll = () => {
      document.documentElement?.style.setProperty('overscroll-behavior', 'contain');
    };

    report('ready');
    containScroll();
    if (document.readyState !== 'complete') {
      window.addEventListener('load', () => report('nav'), { once: true, signal: installSignal });
    }
    // Catches SPA navigations and title changes (only this one frame polls).
    const poll = setInterval(() => {
      if (!extensionAlive()) clearInterval(poll);
      else report('nav');
    }, 1000);
    installSignal.addEventListener('abort', () => clearInterval(poll));

    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      sendMessage({ type: 'frameEvent', token: previewToken, event: 'escape' });
    }, { signal: installSignal });
  }

  if (!IS_TOP) return;

  // ═════════════════════════════════════════════════════════════════════════════
  // Top frame only: the overlay
  // ═════════════════════════════════════════════════════════════════════════════

  /** @type {ReturnType<typeof createOverlay> | null} */
  let activeOverlay = null;
  let previewedOnThisPage = false;

  function showPreview(url, source) {
    if (!isPreviewable(url) || !alive()) return;
    previewedOnThisPage = true;
    let returnFocus = null;
    if (activeOverlay) returnFocus = activeOverlay.closeNow({ restoreFocus: false });
    // One overlay per tab: remove any leftover host, including ones created by a
    // stale copy of this script or still playing a close animation.
    for (const stale of document.querySelectorAll('[data-peeksy]')) stale.remove();
    try {
      activeOverlay = createOverlay(url, returnFocus);
    } catch (err) {
      activeOverlay = null;
      // Don't leave a half-built overlay (and its loading iframe) behind.
      for (const stale of document.querySelectorAll('[data-peeksy]')) stale.remove();
      console.warn('[Peeksy] could not open preview', err);
    }
  }

  // Leaving the page: drop the overlay and every header rule for this tab
  // (only if this page ever opened a preview — don't wake the worker otherwise).
  window.addEventListener('pagehide', () => {
    if (activeOverlay) activeOverlay.closeNow({ restoreFocus: false });
    if (previewedOnThisPage) sendMessage({ type: 'disablePreviewHeaders' });
  }, { signal: installSignal });

  installSignal.addEventListener('abort', () => {
    if (activeOverlay) activeOverlay.closeNow({ restoreFocus: false });
  });

  // ─── Overlay styles ──────────────────────────────────────────────────────────

  const TOOLBAR_H = 40;
  const MIN_W = 420;
  const MIN_H = 260;
  const FIT_WIDTH = 1280;       // desktop layout width the preview is scaled from
  const LOAD_TIMEOUT = 15000;   // nothing at all happened
  const READY_GRACE = 1500;     // load event fired but the document never reported in
  const RULE_WAIT = 3000;       // max wait for the header rule before loading anyway
  const LOOP_WINDOW = 5000;     // reload-loop guard: more than LOOP_MAX_COMMITS page
  const LOOP_MAX_COMMITS = 8;   //   loads inside LOOP_WINDOW ms stops the preview

  const STYLES = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      --pk-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --pk-bar: #18181d;
      --pk-bar-fg: rgba(255, 255, 255, 0.9);
      --pk-bar-muted: rgba(255, 255, 255, 0.5);
      --pk-btn: rgba(255, 255, 255, 0.07);
      --pk-btn-hover: rgba(255, 255, 255, 0.14);
      --pk-btn-border: rgba(255, 255, 255, 0.12);
      --pk-focus: #7ab8ff;
      --pk-fallback-bg: #f6f6f8;
      --pk-fallback-fg: #1a1a1f;
      --pk-fallback-muted: #5c5c66;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --pk-fallback-bg: #1e1e24;
        --pk-fallback-fg: #f1f1f4;
        --pk-fallback-muted: #a3a3ad;
      }
    }

    #backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0);
      transition: background 200ms ease, backdrop-filter 200ms ease;
      pointer-events: none;
    }
    #backdrop.open {
      background: rgba(0, 0, 0, var(--pk-backdrop-alpha, 0.48));
      backdrop-filter: var(--pk-backdrop-filter, blur(4px));
      pointer-events: auto;
    }

    #dialog {
      position: fixed;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      border-radius: 12px;
      overflow: hidden;
      background: var(--pk-bar);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.08);
      opacity: 0;
      transform: scale(0.96);
      transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1), opacity 160ms cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: none;
      font-family: var(--pk-font);
      -webkit-font-smoothing: antialiased;
    }
    #dialog.open {
      opacity: 1;
      transform: none;
      pointer-events: auto;
    }
    #dialog.closing {
      transition-duration: 110ms;
      transition-timing-function: ease-in;
    }
    #dialog:focus { outline: none; }
    #dialog.interacting { user-select: none; }
    #dialog.interacting iframe { pointer-events: none; }

    /* ── Toolbar ── */
    .toolbar {
      position: relative;
      flex: 0 0 ${TOOLBAR_H}px;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 6px;
      box-sizing: border-box;
      color: var(--pk-bar-fg);
      cursor: grab;
      user-select: none;
    }
    #dialog.interacting .toolbar { cursor: grabbing; }

    .group { display: flex; align-items: center; gap: 2px; flex: none; }
    .sep { width: 1px; height: 18px; background: var(--pk-btn-border); margin: 0 4px; flex: none; }

    .address {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 0 8px;
      line-height: 1.25;
    }
    .address .title, .address .url {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .address .title { font-size: 12.5px; font-weight: 600; }
    .address .url { font-size: 11px; color: var(--pk-bar-muted); }
    .address .title:empty { display: none; }

    button {
      all: unset;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 28px;
      min-width: 28px;
      padding: 0 8px;
      border-radius: 7px;
      color: var(--pk-bar-fg);
      font-family: var(--pk-font);
      font-size: 12px;
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;
      cursor: pointer;
      transition: background 80ms ease, color 80ms ease;
    }
    button.icon { padding: 0; width: 28px; }
    button.text { background: var(--pk-btn); border: 1px solid var(--pk-btn-border); }
    button:hover { background: var(--pk-btn-hover); }
    button:active { background: rgba(255, 255, 255, 0.2); }
    button:focus-visible { outline: 2px solid var(--pk-focus); outline-offset: 1px; }
    button:disabled { opacity: 0.35; cursor: default; background: none; }
    button.close:hover { background: #c42b1c; color: #fff; }
    button svg { width: 16px; height: 16px; flex: none; }

    .progress {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 2px;
      overflow: hidden;
      opacity: 0;
      transition: opacity 200ms ease;
    }
    #dialog.loading .progress { opacity: 1; }
    .progress::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      width: 30%;
      background: var(--pk-focus);
      animation: pk-progress 1.1s ease-in-out infinite;
    }
    @keyframes pk-progress {
      from { left: -30%; }
      to { left: 100%; }
    }

    /* ── Content ── */
    .content {
      position: relative;
      flex: 1 1 auto;
      overflow: hidden;
      background: #fff;
    }
    /* Lay out at a desktop width, then zoom so the page fills the overlay width. */
    iframe {
      display: block;
      width: var(--pk-layout-w, 1280px);
      height: var(--pk-layout-h, 800px);
      zoom: var(--pk-scale, 1);
      border: none;
      background: #fff;
    }

    .fallback {
      display: none;
      position: absolute;
      inset: 0;
      z-index: 1;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 32px;
      box-sizing: border-box;
      background: var(--pk-fallback-bg);
      color: var(--pk-fallback-fg);
      text-align: center;
    }
    .fallback.show { display: flex; }
    .fallback h2 { margin: 0; font-size: 16px; font-weight: 600; }
    .fallback p { margin: 0; max-width: 36em; font-size: 13px; line-height: 1.45; color: var(--pk-fallback-muted); }
    .fallback .actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 8px; }
    .fallback button { background: #18181d; color: #fff; border: 1px solid rgba(255, 255, 255, 0.16); padding: 0 14px; }
    .fallback button:hover { background: #33333d; }

    .resize {
      position: absolute;
      right: 0;
      bottom: 0;
      z-index: 2;
      width: 18px;
      height: 18px;
      cursor: nwse-resize;
      background:
        linear-gradient(135deg, transparent 0 55%, rgba(0, 0, 0, 0.35) 55% 62%, transparent 62% 72%,
          rgba(0, 0, 0, 0.35) 72% 79%, transparent 79%);
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
  `;

  const ICONS = {
    back: ['M15 18l-6-6 6-6'],
    forward: ['M9 18l6-6-6-6'],
    reload: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v5h-5'],
    copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
    check: ['M5 12.5l4.5 4.5L19 7'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
  };

  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  /** @param {string} tag @param {Record<string,string>} [attrs] @param {(Node|string)[]} [children] */
  function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v);
    }
    el.append(...children);
    return el;
  }

  function iconButton(name, label, extraClass = '') {
    return h('button', { type: 'button', class: `icon ${extraClass}`.trim(), 'aria-label': label, title: label },
      [icon(name)]);
  }

  function textButton(label, title) {
    return h('button', { type: 'button', class: 'text', title: title || label, text: label });
  }

  function randomToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function displayUrl(url) {
    try {
      const u = new URL(url);
      return (u.host + u.pathname + u.search + u.hash).replace(/\/$/, '');
    } catch {
      return url;
    }
  }

  async function copyText(text, root) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* insecure page or blocked by permissions policy */ }
    const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0;pointer-events:none' });
    ta.value = text;
    root.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }

  // ─── Overlay factory ─────────────────────────────────────────────────────────

  /**
   * @param {string} url
   * @param {Element|null} returnFocusTo element to refocus on close (carried over when replacing a preview)
   */
  function createOverlay(url, returnFocusTo) {
    const controller = new AbortController();
    const { signal } = controller;
    const token = randomToken();
    const previousFocus = returnFocusTo || document.activeElement;

    let currentUrl = url;
    let frameId = null;
    let cleaned = false;
    let loadArmed = false;
    let ruleId = null;
    let embedOk = false;

    // ── DOM ──
    const host = h('div', { 'data-peeksy': '' });
    const shadow = host.attachShadow({ mode: 'closed' });

    const backdrop = h('div', { id: 'backdrop' });

    const btnBack = iconButton('back', 'Back');
    const btnForward = iconButton('forward', 'Forward');
    const btnReload = iconButton('reload', 'Reload');
    btnBack.disabled = true;
    btnForward.disabled = true;

    const titleEl = h('div', { class: 'title' });
    const urlEl = h('div', { class: 'url', text: displayUrl(url) });
    const address = h('div', { class: 'address', title: url }, [titleEl, urlEl]);

    const btnCopy = iconButton('copy', 'Copy link');
    const btnHere = textButton('Open here', 'Open in this tab');
    const btnTab = textButton('New tab', 'Open in a new tab');
    const btnWindow = textButton('Window', 'Open in a popup window');
    const btnClose = iconButton('close', 'Close preview (Esc)', 'close');
    const status = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });

    const toolbar = h('div', { class: 'toolbar' }, [
      h('div', { class: 'group' }, [btnBack, btnForward, btnReload]),
      address,
      h('div', { class: 'group' }, [btnCopy, h('div', { class: 'sep' }), btnHere, btnTab, btnWindow,
        h('div', { class: 'sep' }), btnClose]),
      h('div', { class: 'progress' }),
      status,
    ]);

    // allow-scripts + allow-same-origin is required for real site previews.
    // A framed page that is same-origin with this tab could lift its own sandbox —
    // acceptable for a user-initiated preview tool.
    const iframe = h('iframe', {
      title: 'Link preview',
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals',
      allow: 'autoplay; fullscreen; encrypted-media; clipboard-write',
      referrerpolicy: 'strict-origin-when-cross-origin',
    });

    const fbTitle = h('h2', { text: 'This page can’t be previewed' });
    const fbBody = h('p');
    const fbRetry = textButton('Try again');
    const fbHere = textButton('Open here', 'Open in this tab');
    const fbTab = textButton('New tab', 'Open in a new tab');
    const fbWindow = textButton('Window', 'Open in a popup window');
    const fallback = h('div', { class: 'fallback', role: 'alert' }, [
      fbTitle, fbBody, h('div', { class: 'actions' }, [fbRetry, fbHere, fbTab, fbWindow]),
    ]);

    const content = h('div', { class: 'content' }, [iframe, fallback]);
    const resizer = h('div', { class: 'resize', title: 'Drag to resize', 'aria-hidden': 'true' });

    const dialog = h('div', {
      id: 'dialog',
      class: 'loading',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Link preview',
      tabindex: '-1',
    }, [toolbar, content, resizer]);

    shadow.append(h('style', { text: STYLES }), backdrop, dialog);

    host.style.setProperty('--pk-backdrop-alpha', (settings.backdropOpacity / 100).toFixed(2));
    host.style.setProperty('--pk-backdrop-filter', settings.backdropBlur ? 'blur(4px)' : 'none');

    // ── Geometry: px box, centered from the size settings until the user moves/resizes it ──
    const userZoom = settings.defaultZoom / 100;
    const geo = { x: 0, y: 0, w: 0, h: 0 };
    let placedByUser = false;

    // clientWidth/Height exclude scrollbars, but in quirks mode they report the
    // whole document — fall back to the window size there.
    const viewport = () => {
      const root = document.documentElement;
      const standards = document.compatMode === 'CSS1Compat' && root.clientWidth && root.clientHeight;
      return {
        vw: standards ? root.clientWidth : window.innerWidth,
        vh: standards ? root.clientHeight : window.innerHeight,
      };
    };

    function centerGeometry() {
      const { vw, vh } = viewport();
      geo.w = Math.min(vw, Math.max(Math.min(MIN_W, vw), Math.round(vw * settings.overlayWidth / 100)));
      geo.h = Math.min(vh, Math.max(Math.min(MIN_H, vh), Math.round(vh * settings.overlayHeight / 100)));
      geo.x = Math.round((vw - geo.w) / 2);
      geo.y = Math.round((vh - geo.h) / 2);
    }

    function clampGeometry() {
      const { vw, vh } = viewport();
      geo.w = Math.min(geo.w, vw);
      geo.h = Math.min(geo.h, vh);
      geo.x = Math.min(Math.max(0, geo.x), vw - geo.w);
      geo.y = Math.min(Math.max(0, geo.y), vh - geo.h);
    }

    function applyGeometry() {
      dialog.style.left = geo.x + 'px';
      dialog.style.top = geo.y + 'px';
      dialog.style.width = geo.w + 'px';
      dialog.style.height = geo.h + 'px';
      const layoutW = Math.round(FIT_WIDTH / userZoom);
      const scale = geo.w / layoutW;
      const layoutH = Math.max(1, Math.ceil((geo.h - TOOLBAR_H) / scale));
      host.style.setProperty('--pk-layout-w', layoutW + 'px');
      host.style.setProperty('--pk-layout-h', layoutH + 'px');
      host.style.setProperty('--pk-scale', String(scale));
    }

    centerGeometry();
    applyGeometry();
    (document.body || document.documentElement).appendChild(host);

    window.addEventListener('resize', () => {
      if (placedByUser) clampGeometry();
      else centerGeometry();
      applyGeometry();
    }, { signal });

    // ── Load state ──
    // A document "signal" means a real page committed in the preview frame:
    // webNavigation commit (relayed by the background), the preview's own script
    // reporting in, or — same-origin only — reading the frame's document directly.
    // A webNavigation error is a definite "blocked". Silence after the frame's load
    // event is only a last resort, for when the frame couldn't be tracked at all.
    let signalBeforeLoad = false; // signal arrived for a document whose load hasn't fired yet
    let awaitingSignal = false;   // load fired, no signal seen yet
    let graceTimer = 0;
    let lastErrorUrl = null;      // URL of the navigation webNavigation reported as failed
    let halted = false;           // preview stopped because it kept reloading
    const commitTimes = [];

    /** A page that reloads/redirects itself endlessly inside the preview is stopped. */
    function reloadLoopDetected() {
      const now = performance.now();
      commitTimes.push(now);
      while (commitTimes.length && now - commitTimes[0] > LOOP_WINDOW) commitTimes.shift();
      return commitTimes.length > LOOP_MAX_COMMITS;
    }

    function haltPreview() {
      halted = true;
      awaitingSignal = false;
      clearTimeout(graceTimer);
      clearTimeout(loadTimer);
      iframe.src = 'about:blank';
      showFallback('loop');
    }

    function setLoading(on) {
      dialog.classList.toggle('loading', on);
    }

    function showFallback(reason) {
      if (cleaned) return;
      setLoading(false);
      fbBody.textContent = {
        timeout: 'The page took too long to respond. Open it another way:',
        loop: 'The page kept reloading itself inside the preview, so Peeksy stopped it. Open it another way:',
      }[reason] || 'The site refuses to be shown inside another page. Open it another way:';
      fallback.classList.add('show');
      iframe.style.visibility = 'hidden';
      status.textContent = 'This page can’t be previewed';
    }

    function markOk() {
      if (cleaned) return;
      embedOk = true;
      fallback.classList.remove('show');
      iframe.style.visibility = '';
    }

    /** Same-origin previews can be inspected directly. */
    function sameOriginDocumentLoaded() {
      try {
        const href = iframe.contentDocument?.location?.href || '';
        return Boolean(href) && href !== 'about:blank' && !href.startsWith('chrome-error:');
      } catch {
        return false;
      }
    }

    function onDocumentSignal() {
      if (awaitingSignal) {
        awaitingSignal = false;
        clearTimeout(graceTimer);
      } else {
        signalBeforeLoad = true;
      }
      markOk();
    }

    function onNavigationError(failedUrl) {
      lastErrorUrl = failedUrl || null;
      signalBeforeLoad = false;
      awaitingSignal = false;
      clearTimeout(graceTimer);
      showFallback('blocked');
    }

    function onIframeLoad() {
      if (cleaned || !loadArmed || halted) return;
      setLoading(false);
      clearTimeout(graceTimer);
      if (fallback.classList.contains('show') && lastErrorUrl) return; // error page finished loading
      if (signalBeforeLoad || sameOriginDocumentLoaded()) {
        signalBeforeLoad = false;
        markOk();
        return;
      }
      awaitingSignal = true;
      graceTimer = setTimeout(() => {
        if (!awaitingSignal) return;
        awaitingSignal = false;
        if (sameOriginDocumentLoaded()) markOk();
        else showFallback('blocked');
      }, READY_GRACE);
    }

    let loadTimer = 0;

    function load(target) {
      embedOk = false;
      signalBeforeLoad = false;
      awaitingSignal = false;
      lastErrorUrl = null;
      halted = false;
      commitTimes.length = 0;
      clearTimeout(graceTimer);
      clearTimeout(loadTimer);
      loadTimer = setTimeout(() => {
        if (!embedOk && !awaitingSignal && !fallback.classList.contains('show')) showFallback('timeout');
      }, LOAD_TIMEOUT);
      fallback.classList.remove('show');
      iframe.style.visibility = '';
      setLoading(true);
      iframe.src = target;
    }

    function armAndLoad() {
      if (cleaned || loadArmed) return;
      loadArmed = true;
      iframe.addEventListener('load', onIframeLoad, { signal });
      load(url);
    }

    // Header rule first, then load. If the service worker is slow to wake, load
    // anyway and reload once the rule exists.
    sendMessage({ type: 'enablePreviewHeaders', url, token }).then((res) => {
      if (res?.ok) ruleId = res.ruleId;
      if (cleaned) {
        if (ruleId != null) sendMessage({ type: 'disablePreviewHeaders', ruleId });
        return;
      }
      if (!loadArmed) armAndLoad();
      else if (res?.ok && !embedOk) load(currentUrl);
    });
    setTimeout(armAndLoad, RULE_WAIT);

    function onFrameEvent(msg) {
      if (cleaned || msg.token !== token) return;
      if (msg.event === 'escape') {
        close();
        return;
      }
      if (Number.isInteger(msg.frameId)) frameId = msg.frameId;
      if (halted) return;

      switch (msg.event) {
        case 'error':
          // ERR_ABORTED = superseded navigation, download, 204 — not a block.
          if (msg.error !== 'net::ERR_ABORTED') onNavigationError(msg.url);
          return;
        case 'committed':
          // Chrome also reports the error page it commits for a blocked load.
          if (String(msg.url).startsWith('chrome-error:') || (lastErrorUrl && msg.url === lastErrorUrl)) return;
          if (reloadLoopDetected()) {
            haltPreview();
            return;
          }
          lastErrorUrl = null;
          onDocumentSignal();
          break;
        case 'ready':
          lastErrorUrl = null;
          onDocumentSignal();
          break;
        default:
          break;
      }

      if (isPreviewable(msg.url)) {
        currentUrl = msg.url;
        urlEl.textContent = displayUrl(currentUrl);
        address.title = currentUrl;
      }
      if (typeof msg.title === 'string') {
        titleEl.textContent = msg.title;
        dialog.setAttribute('aria-label', msg.title ? `Link preview: ${msg.title}` : 'Link preview');
      }
      if (typeof msg.canGoBack === 'boolean') {
        btnBack.disabled = !msg.canGoBack;
        btnForward.disabled = !msg.canGoForward;
      }
    }

    // ── Open / close ──
    let restoreFocus = true;

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(loadTimer);
      clearTimeout(graceTimer);
      controller.abort();
      iframe.src = 'about:blank';
      host.remove();
      if (ruleId != null) sendMessage({ type: 'disablePreviewHeaders', ruleId });
      if (restoreFocus && previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
        try { previousFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    }

    function detach() {
      if (activeOverlay === overlay) activeOverlay = null;
    }

    function close() {
      detach();
      if (cleaned || dialog.classList.contains('closing')) return;
      dialog.classList.add('closing');
      dialog.classList.remove('open');
      backdrop.classList.remove('open');
      dialog.addEventListener('transitionend', cleanup, { once: true, signal });
      setTimeout(cleanup, 180);
    }

    /** @returns {Element|null} the element focus would have returned to */
    function closeNow({ restoreFocus: restore = true } = {}) {
      detach();
      restoreFocus = restore;
      cleanup();
      return previousFocus;
    }

    function openHere() {
      restoreFocus = false;
      cleanup();
      detach();
      location.href = currentUrl;
    }

    async function openInNewTab() {
      const res = await sendMessage({ type: 'openTab', url: currentUrl });
      if (!res?.ok) window.open(currentUrl, '_blank', 'noopener,noreferrer');
      close();
    }

    async function openAsWindow() {
      const res = await sendMessage({
        type: 'openPopup',
        url: currentUrl,
        screenAvailLeft: screen.availLeft ?? 0,
        screenAvailTop: screen.availTop ?? 0,
        screenAvailWidth: screen.availWidth,
        screenAvailHeight: screen.availHeight,
      });
      if (res?.ok) close();
    }

    async function copyLink() {
      const ok = await copyText(currentUrl, shadow);
      btnCopy.replaceChildren(icon(ok ? 'check' : 'copy'));
      status.textContent = ok ? 'Link copied' : 'Could not copy the link';
      setTimeout(() => btnCopy.replaceChildren(icon('copy')), 1200);
    }

    function navigate(cmd) {
      if (frameId != null) sendMessage({ type: 'frameCommand', frameId, token, cmd });
    }

    const on = (el, type, fn, opts = {}) => el.addEventListener(type, fn, { ...opts, signal });

    on(btnBack, 'click', () => navigate('back'));
    on(btnForward, 'click', () => navigate('forward'));
    on(btnReload, 'click', () => load(currentUrl));
    on(btnCopy, 'click', copyLink);
    on(btnClose, 'click', () => close());
    on(fbRetry, 'click', () => load(currentUrl));
    for (const btn of [btnHere, fbHere]) on(btn, 'click', openHere);
    for (const btn of [btnTab, fbTab]) on(btn, 'click', openInNewTab);
    for (const btn of [btnWindow, fbWindow]) on(btn, 'click', openAsWindow);

    // Click outside closes; the backdrop also stops the page behind from scrolling.
    on(backdrop, 'mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      close();
    });
    on(shadow, 'wheel', (e) => e.preventDefault(), { passive: false });
    on(shadow, 'touchmove', (e) => e.preventDefault(), { passive: false });

    // ── Keyboard ──
    const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown',
      'Home', 'End', ' ']);

    // Tab cycles through the overlay's controls and the preview. This only ever
    // reacts to the user's key presses — it never fights the page over focus.
    function cycleFocus(backwards) {
      const items = [btnBack, btnForward, btnReload, btnCopy, btnHere, btnTab, btnWindow, btnClose,
        ...(fallback.classList.contains('show') ? [fbRetry, fbHere, fbTab, fbWindow] : [iframe])]
        .filter((el) => !el.disabled);
      const i = items.indexOf(shadow.activeElement);
      const next = i === -1
        ? (backwards ? items.length - 1 : 0)
        : (i + (backwards ? -1 : 1) + items.length) % items.length;
      items[next].focus({ preventScroll: true });
    }

    on(window, 'keydown', (e) => {
      if (e.key === 'Escape' && !e.isComposing) {
        swallow(e);
        close();
        return;
      }
      if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        cycleFocus(e.shiftKey);
        return;
      }
      // Focus is on the overlay chrome (or nowhere): don't let keys scroll the
      // page behind. Space still activates a focused button.
      const origin = e.composedPath()[0];
      const fromOverlay = e.composedPath().includes(host);
      const fromNowhere = origin === document.body || origin === document.documentElement || origin === document;
      if ((fromOverlay || fromNowhere) && SCROLL_KEYS.has(e.key)
        && !(e.key === ' ' && origin?.localName === 'button')) {
        e.preventDefault();
      }
    }, { capture: true });

    // ── Drag (toolbar) and resize (corner) ──
    function startPointerGesture(e, onMove, onEnd) {
      if (e.button !== 0) return;
      e.preventDefault();
      const target = e.currentTarget;
      const gesture = new AbortController();
      const opts = { signal: gesture.signal };
      const startX = e.clientX;
      const startY = e.clientY;
      const start = { ...geo };
      target.setPointerCapture(e.pointerId);
      dialog.classList.add('interacting');
      target.addEventListener('pointermove', (ev) => {
        onMove(ev.clientX - startX, ev.clientY - startY, start);
        applyGeometry();
      }, opts);
      const end = () => {
        gesture.abort();
        dialog.classList.remove('interacting');
        onEnd?.();
      };
      target.addEventListener('pointerup', end, opts);
      target.addEventListener('pointercancel', end, opts);
      signal.addEventListener('abort', () => gesture.abort(), opts);
    }

    on(toolbar, 'pointerdown', (e) => {
      if (e.composedPath().some((n) => n.localName === 'button')) return;
      startPointerGesture(e, (dx, dy, start) => {
        placedByUser = true;
        geo.x = start.x + dx;
        geo.y = start.y + dy;
        clampGeometry();
      });
    });

    on(toolbar, 'dblclick', (e) => {
      if (e.composedPath().some((n) => n.localName === 'button')) return;
      placedByUser = false;
      centerGeometry();
      applyGeometry();
    });

    on(resizer, 'pointerdown', (e) => {
      startPointerGesture(e, (dx, dy, start) => {
        const { vw, vh } = viewport();
        placedByUser = true;
        geo.w = Math.min(vw - start.x, Math.max(Math.min(MIN_W, vw), start.w + dx));
        geo.h = Math.min(vh - start.y, Math.max(Math.min(MIN_H, vh), start.h + dy));
      }, () => {
        // Remember the new size for future previews.
        const { vw, vh } = viewport();
        Settings.save({
          overlayWidth: Math.round((geo.w / vw) * 100),
          overlayHeight: Math.round((geo.h / vh) * 100),
        }).catch(() => {});
      });
    });

    // ── Open animation ──
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
      dialog.classList.add('open');
      dialog.focus({ preventScroll: true });
    });

    const overlay = { close, closeNow, onFrameEvent };
    return overlay;
  }
})();
