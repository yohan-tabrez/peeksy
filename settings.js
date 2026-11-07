// Shared settings schema — loaded by the content script, background and options page.
// Wrapped in an IIFE and assigned to globalThis so re-injection never throws on redeclaration.
(() => {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled:         true,
    triggerKey:      'alt',    // 'alt' | 'altShift' | 'altCtrl'
    hoverPreview:    false,
    hoverDelay:      700,      // ms
    overlayWidth:    80,       // % of viewport
    overlayHeight:   80,       // % of viewport
    defaultZoom:     100,      // %
    backdropOpacity: 48,       // %
    backdropBlur:    true,
    disabledSites:   [],       // hostnames; subdomains match too
  });

  const RANGES = {
    hoverDelay:      [200, 2000],
    overlayWidth:    [30, 100],
    overlayHeight:   [30, 100],
    defaultZoom:     [25, 200],
    backdropOpacity: [0, 80],
  };

  const TRIGGERS = ['alt', 'altShift', 'altCtrl'];

  function clampInt(value, [min, max], fallback) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  /** Accepts a hostname or a pasted URL; returns a bare lowercase hostname without "www.", or ''. */
  function normalizeHost(input) {
    let host = String(input ?? '').trim().toLowerCase();
    if (!host) return '';
    try {
      host = new URL(host.includes('://') ? host : 'http://' + host).hostname;
    } catch {
      return '';
    }
    host = host.replace(/^www\./, '').replace(/\.$/, '');
    return /^[a-z0-9.-]+$/.test(host) && host.includes('.') ? host : (host === 'localhost' ? host : '');
  }

  function siteMatches(host, site) {
    const h = String(host || '').toLowerCase().replace(/^www\./, '');
    return h === site || h.endsWith('.' + site);
  }

  function isSiteDisabled(host, sites) {
    return Array.isArray(sites) && sites.some((site) => siteMatches(host, site));
  }

  function normalize(raw) {
    const s = { ...DEFAULTS, ...(raw || {}) };
    const out = {};
    out.enabled = s.enabled !== false;
    out.triggerKey = s.triggerKey === 'altMeta' ? 'altCtrl'
      : TRIGGERS.includes(s.triggerKey) ? s.triggerKey : DEFAULTS.triggerKey;
    out.hoverPreview = s.hoverPreview === true;
    out.backdropBlur = s.backdropBlur !== false;
    for (const [key, range] of Object.entries(RANGES)) {
      out[key] = clampInt(s[key], range, DEFAULTS[key]);
    }
    const sites = Array.isArray(s.disabledSites) ? s.disabledSites.map(normalizeHost).filter(Boolean) : [];
    out.disabledSites = [...new Set(sites)].sort();
    return out;
  }

  const storage = () => chrome.storage.sync;

  async function load() {
    return normalize(await storage().get(Object.keys(DEFAULTS)));
  }

  function save(partial) {
    return storage().set(partial);
  }

  globalThis.PeeksySettings = Object.freeze({
    AREA: 'sync',
    DEFAULTS,
    RANGES,
    normalize,
    normalizeHost,
    siteMatches,
    isSiteDisabled,
    load,
    save,
  });
})();
