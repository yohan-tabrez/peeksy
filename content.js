(() => {
  'use strict';

  // Re-injection after extension reload must replace dead listeners.
  // Abort any previous install in this page instead of bailing out forever.
  if (window.__peeksyAbort) {
    try { window.__peeksyAbort.abort(); } catch { /* ignore */ }
  }
  const installAbort = new AbortController();
  window.__peeksyAbort = installAbort;
  const installSignal = installAbort.signal;

  /** @type {{ close: () => void, closeNow: () => void } | null} */
  let activeOverlay = null;

  // ─── Settings ────────────────────────────────────────────────────────────────

  const DEFAULTS = {
    overlayWidth:    80,
    overlayHeight:   80,
    defaultZoom:    100,
    triggerKey:   'alt',   // 'alt' | 'altShift' | 'altCtrl'
    backdropOpacity: 48,
    backdropBlur:  true,
  };

  let settings = { ...DEFAULTS };

  function extensionAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  /** @param {object} msg */
  function sendMessage(msg) {
    return new Promise((resolve) => {
      if (!extensionAlive()) {
        resolve({ ok: false, error: 'Extension context invalidated' });
        return;
      }
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res ?? { ok: true });
          }
        });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  }

  function loadSettings() {
    if (!extensionAlive()) return;
    try {
      chrome.storage.local.get(DEFAULTS, (stored) => {
        if (chrome.runtime.lastError || !stored) return;
        if (stored.triggerKey === 'altMeta') {
          stored.triggerKey = 'altCtrl';
          try { chrome.storage.local.set({ triggerKey: 'altCtrl' }); } catch { /* ignore */ }
        }
        Object.assign(settings, stored);
      });
    } catch {
      /* context invalidated */
    }
  }

  loadSettings();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (!(key in settings) || newValue === undefined) continue;
        settings[key] = key === 'triggerKey' && newValue === 'altMeta' ? 'altCtrl' : newValue;
      }
    });
  } catch {
    /* context invalidated */
  }

  // ─── URL helpers ──────────────────────────────────────────────────────────────

  function resolveUrl(href) {
    if (!href) return null;
    try {
      return new URL(href, document.baseURI).href;
    } catch {
      return null;
    }
  }

  function isPreviewable(url) {
    if (!url) return false;
    try {
      const { protocol } = new URL(url);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Find an <a href> from a click target, including SVG links and open shadow trees.
   * @param {EventTarget|null} el
   * @param {Event} e
   * @returns {Element|null}
   */
  function findAnchor(el, e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (const node of path) {
      if (node && node.tagName && node.tagName.toUpperCase() === 'A' && node.getAttribute?.('href')) {
        return node;
      }
    }

    let node = el;
    while (node && node !== document.documentElement) {
      if (node.tagName && node.tagName.toUpperCase() === 'A' && node.getAttribute('href')) {
        return node;
      }
      node = node.parentElement || node.parentNode;
      if (node && node.nodeType === Node.DOCUMENT_FRAGMENT_NODE && node.host) {
        node = node.host;
      }
    }
    return null;
  }

  // ─── Shadow DOM styles ────────────────────────────────────────────────────────

  function buildStyles() {
    return `
      :host {
        all: initial;
        display: block;
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
        overflow: visible;
      }

      #peeksy-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0);
        backdrop-filter: blur(0px);
        -webkit-backdrop-filter: blur(0px);
        transition: background 200ms ease, backdrop-filter 200ms ease,
                    -webkit-backdrop-filter 200ms ease;
        pointer-events: none;
        cursor: default;
      }
      #peeksy-backdrop.open {
        background: rgba(0, 0, 0, var(--peeksy-ba, 0.48));
        backdrop-filter: var(--peeksy-bf, blur(4px));
        -webkit-backdrop-filter: var(--peeksy-bf, blur(4px));
      }

      #peeksy-container {
        position: fixed;
        top: 50%;
        left: 50%;
        width: var(--peeksy-ow, 80vw);
        height: var(--peeksy-oh, 80vh);
        transform: translate(-50%, -50%) scale(0.94);
        opacity: 0;
        pointer-events: none;
        transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1),
                    opacity  160ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      #peeksy-container.open {
        transform: translate(-50%, -50%) scale(1);
        opacity: 1;
        pointer-events: auto;
      }

      .peeksy-btn-bar {
        position: absolute;
        top: 12px;
        right: 12px;
        z-index: 2;
        display: flex;
        gap: 8px;
        pointer-events: auto;
      }

      .peeksy-btn {
        all: unset;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0 14px;
        height: 28px;
        border-radius: 14px;
        background: rgba(18, 18, 24, 0.88);
        border: 1px solid rgba(255, 255, 255, 0.16);
        color: rgba(255, 255, 255, 0.88);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px;
        font-weight: 500;
        line-height: 1;
        letter-spacing: 0.01em;
        cursor: pointer;
        backdrop-filter: blur(24px);
        -webkit-backdrop-filter: blur(24px);
        white-space: nowrap;
        -webkit-font-smoothing: antialiased;
        transition: background 80ms ease, border-color 80ms ease, transform 80ms ease;
        user-select: none;
        -webkit-user-select: none;
      }
      .peeksy-btn:hover {
        background: rgba(50, 50, 65, 0.96);
        border-color: rgba(255, 255, 255, 0.30);
        transform: translateY(-1px);
      }
      .peeksy-btn:active {
        transform: none;
        background: rgba(70, 70, 88, 1);
        transition-duration: 40ms;
      }

      .peeksy-content {
        position: relative;
        width: 100%;
        height: 100%;
        border-radius: 12px;
        overflow: hidden;
        box-shadow:
          0 24px 80px rgba(0, 0, 0, 0.65),
          0 0 0 1px rgba(255, 255, 255, 0.07);
        background: #fff;
      }

      /* Desktop layout width, then CSS zoom so used size fills the overlay (no side gaps). */
      #peeksy-iframe {
        display: block;
        width: var(--peeksy-layout-w, 1280px);
        height: var(--peeksy-layout-h, 800px);
        zoom: var(--peeksy-scale, 1);
        border: none;
        background: #fff;
      }

      .peeksy-fallback {
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
        background: #f6f6f8;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        text-align: center;
        -webkit-font-smoothing: antialiased;
      }
      .peeksy-fallback.show {
        display: flex;
      }
      .peeksy-fallback h2 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        color: #1a1a1f;
      }
      .peeksy-fallback p {
        margin: 0;
        max-width: 36em;
        font-size: 13px;
        line-height: 1.45;
        color: #5c5c66;
      }
      .peeksy-fallback-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: center;
        margin-top: 8px;
      }
      .peeksy-fallback .peeksy-btn {
        background: rgba(18, 18, 24, 0.92);
      }
    `;
  }

  // ─── Overlay factory ──────────────────────────────────────────────────────────

  /**
   * @param {string} url
   * @param {number} [openEventTime] mousedown timeStamp that opened this overlay
   */
  function createOverlay(url, openEventTime) {
    const controller = new AbortController();
    const { signal } = controller;

    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = buildStyles();
    shadow.appendChild(style);

    const backdrop = document.createElement('div');
    backdrop.id = 'peeksy-backdrop';
    shadow.appendChild(backdrop);

    const container = document.createElement('div');
    container.id = 'peeksy-container';
    shadow.appendChild(container);

    const btnBar = document.createElement('div');
    btnBar.className = 'peeksy-btn-bar';
    container.appendChild(btnBar);

    const BUTTON_LABELS = ['Open in this tab', 'Open in new tab', 'Open as window'];
    BUTTON_LABELS.forEach((label) => {
      const btn = document.createElement('button');
      btn.className = 'peeksy-btn';
      btn.type = 'button';
      btn.textContent = label;
      btnBar.appendChild(btn);
    });

    const [btnThisTab, btnNewTab, btnWindow] = btnBar.children;

    const content = document.createElement('div');
    content.className = 'peeksy-content';
    container.appendChild(content);

    // allow-scripts + allow-same-origin is required for real site previews
    // (cookies, storage). Framed pages could escape the sandbox into this tab —
    // acceptable for a user-initiated preview tool; do not use for untrusted embeds.
    const iframe = document.createElement('iframe');
    iframe.id = 'peeksy-iframe';
    iframe.setAttribute('sandbox', [
      'allow-scripts',
      'allow-same-origin',
      'allow-forms',
      'allow-popups',
      'allow-downloads',
      'allow-modals',
    ].join(' '));
    iframe.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
    content.appendChild(iframe);

    const fallback = document.createElement('div');
    fallback.className = 'peeksy-fallback';
    fallback.setAttribute('role', 'alert');
    const fallbackTitle = document.createElement('h2');
    fallbackTitle.textContent = 'This page can’t be previewed';
    const fallbackBody = document.createElement('p');
    fallbackBody.textContent =
      'The site blocks embedding (or the preview timed out). Open it another way:';
    const fallbackActions = document.createElement('div');
    fallbackActions.className = 'peeksy-fallback-actions';
    const fbThis = document.createElement('button');
    fbThis.className = 'peeksy-btn';
    fbThis.type = 'button';
    fbThis.textContent = 'Open in this tab';
    const fbNew = document.createElement('button');
    fbNew.className = 'peeksy-btn';
    fbNew.type = 'button';
    fbNew.textContent = 'Open in new tab';
    const fbWin = document.createElement('button');
    fbWin.className = 'peeksy-btn';
    fbWin.type = 'button';
    fbWin.textContent = 'Open as window';
    fallbackActions.append(fbThis, fbNew, fbWin);
    fallback.append(fallbackTitle, fallbackBody, fallbackActions);
    content.appendChild(fallback);

    // Lay out at a desktop width, then zoom so the iframe always fills the overlay
    // (user zoom changes how much page fits — not empty side bands).
    const FIT_WIDTH = 1280;
    const userZoom = Math.max(0.25, (Number(settings.defaultZoom) || 100) / 100);
    const availW = document.documentElement.clientWidth;
    const availH = document.documentElement.clientHeight;
    const owPx = Math.round(availW * settings.overlayWidth / 100);
    const ohPx = Math.round(availH * settings.overlayHeight / 100);
    const layoutW = Math.round(FIT_WIDTH / userZoom);
    const scale = owPx / layoutW;
    const layoutH = Math.max(1, Math.round(ohPx / scale));

    host.style.setProperty('--peeksy-ow', owPx + 'px');
    host.style.setProperty('--peeksy-oh', ohPx + 'px');
    host.style.setProperty('--peeksy-layout-w', layoutW + 'px');
    host.style.setProperty('--peeksy-layout-h', layoutH + 'px');
    host.style.setProperty('--peeksy-scale', String(scale));
    host.style.setProperty('--peeksy-ba', (settings.backdropOpacity / 100).toFixed(2));
    host.style.setProperty('--peeksy-bf', settings.backdropBlur ? 'blur(4px)' : 'blur(0px)');

    const mountParent = document.body || document.documentElement;
    mountParent.appendChild(host);

    let settled = false;
    let headersEnabled = false;
    let cleaned = false;
    let loadArmed = false; // ignore about:blank load before we assign src

    function showFallback() {
      if (cleaned) return;
      settled = true;
      fallback.classList.add('show');
      iframe.style.visibility = 'hidden';
    }

    function markOk() {
      if (cleaned) return;
      settled = true;
      fallback.classList.remove('show');
      iframe.style.visibility = '';
    }

    /** @returns {'blocked'|'ok'|'pending'} */
    function embedState() {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return 'blocked';
        const href = doc.location?.href || '';
        // Intermediate blank (initial frame or redirect hop) — wait for next load/timeout
        if (!href || href === 'about:blank') return 'pending';
        if (href.startsWith('chrome-error://') || href.startsWith('chrome://')) return 'blocked';
        return 'ok';
      } catch {
        // Cross-origin document loaded — framing succeeded
        return 'ok';
      }
    }

    function onIframeLoad() {
      if (cleaned || !loadArmed) return;
      const state = embedState();
      if (state === 'pending') return;
      if (state === 'blocked') showFallback();
      else markOk();
    }

    iframe.addEventListener('error', () => {
      if (loadArmed) showFallback();
    }, { signal });

    const loadTimer = setTimeout(() => {
      if (!settled) showFallback();
    }, 12000);

    // Enable scoped DNR rules, then load. Don't hang forever if the SW is asleep.
    const armAndLoad = (res) => {
      if (cleaned) {
        if (res && res.ok) sendMessage({ type: 'disablePreviewHeaders' });
        return;
      }
      if (res && res.ok) headersEnabled = true;
      if (loadArmed) return;
      loadArmed = true;
      iframe.addEventListener('load', onIframeLoad, { signal });
      iframe.src = url;
    };

    Promise.race([
      sendMessage({ type: 'enablePreviewHeaders', url }),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'timeout' }), 400)),
    ]).then(armAndLoad);

    container.style.willChange = 'transform, opacity';
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
      container.classList.add('open');
      container.addEventListener('transitionend', () => {
        container.style.willChange = 'auto';
      }, { once: true, signal });
    });

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(loadTimer);
      controller.abort();
      iframe.removeEventListener('load', onIframeLoad);
      iframe.src = 'about:blank';
      host.remove();
      if (headersEnabled || extensionAlive()) {
        sendMessage({ type: 'disablePreviewHeaders' });
      }
    }

    function close() {
      if (activeOverlay === overlayRef) activeOverlay = null;
      if (cleaned) return;

      container.style.willChange = 'transform, opacity';
      backdrop.classList.remove('open');
      container.style.transition = 'transform 110ms ease-in, opacity 110ms ease-in';
      container.classList.remove('open');

      container.addEventListener('transitionend', cleanup, { once: true, signal });
      setTimeout(cleanup, 160);
    }

    function closeNow() {
      if (activeOverlay === overlayRef) activeOverlay = null;
      cleanup();
    }

    function openInThisTab() {
      location.href = url;
      cleanup();
    }

    function openInNewTab() {
      window.open(url, '_blank', 'noopener,noreferrer');
      close();
    }

    async function openAsWindow() {
      const res = await sendMessage({
        type: 'openPopup',
        url,
        screenAvailLeft:   screen.availLeft  ?? 0,
        screenAvailTop:    screen.availTop   ?? 0,
        screenAvailWidth:  screen.availWidth,
        screenAvailHeight: screen.availHeight,
      });
      if (res && res.ok) close();
    }

    document.addEventListener('mousedown', (e) => {
      // Don't dismiss on the same click that opened the overlay
      if (openEventTime != null && e.timeStamp === openEventTime) return;
      const rect = container.getBoundingClientRect();
      if (
        e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top  || e.clientY > rect.bottom
      ) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        close();
      }
    }, { signal, capture: true });

    btnThisTab.addEventListener('click', openInThisTab, { signal });
    btnNewTab.addEventListener('click', openInNewTab, { signal });
    btnWindow.addEventListener('click', () => { openAsWindow(); }, { signal });
    fbThis.addEventListener('click', openInThisTab, { signal });
    fbNew.addEventListener('click', openInNewTab, { signal });
    fbWin.addEventListener('click', () => { openAsWindow(); }, { signal });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }, { signal });

    window.addEventListener('beforeunload', closeNow, { signal });

    const overlayRef = { close, closeNow };
    installSignal.addEventListener('abort', closeNow, { once: true });
    return overlayRef;
  }

  // ─── Global trigger interceptor ───────────────────────────────────────────────

  function matchesTrigger(e) {
    switch (settings.triggerKey) {
      case 'altShift': return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
      case 'altCtrl':  return e.altKey && e.ctrlKey  && !e.shiftKey && !e.metaKey;
      case 'altMeta':  return e.altKey && e.ctrlKey  && !e.shiftKey && !e.metaKey; // legacy
      default:         return e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey;
    }
  }

  function getAltClickTarget(e) {
    const target = (e.composedPath && e.composedPath()[0]) || e.target;
    const anchor = findAnchor(target, e);
    if (!anchor) return null;
    const url = resolveUrl(anchor.getAttribute('href'));
    if (!isPreviewable(url)) return null;
    return url;
  }

  document.addEventListener('mousedown', (e) => {
    if (!matchesTrigger(e) || e.button !== 0) return;

    const url = getAltClickTarget(e);
    if (!url) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (activeOverlay) activeOverlay.closeNow();
    try {
      activeOverlay = createOverlay(url, e.timeStamp);
    } catch {
      activeOverlay = null;
    }
  }, { capture: true, signal: installSignal });

  document.addEventListener('click', (e) => {
    if (!matchesTrigger(e)) return;
    if (!getAltClickTarget(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, { capture: true, signal: installSignal });

})();
