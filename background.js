'use strict';

// Chrome runs this as a service worker; Firefox loads settings.js first via background.scripts.
if (typeof importScripts === 'function' && !globalThis.PeeksySettings) {
  importScripts('settings.js');
}
const Settings = globalThis.PeeksySettings;
const IS_FIREFOX = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validateHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function hostOf(url) {
  return validateHttpUrl(url)?.hostname ?? '';
}

function isTabId(id) {
  return Number.isInteger(id) && id >= 0;
}

/** Message the top frame of a tab. Resolves to undefined if nothing is listening there. */
function sendToTop(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => undefined);
}

// ─── Scoped header stripping (declarativeNetRequest session rules) ───────────
//
// While a preview is open, frame-blocking headers are removed for sub-frames in
// that one tab. The rule is not host-scoped so redirects (short links, www.,
// sign-in hops) keep working. Each preview gets its own rule id so a late
// "disable" from a previous preview can never remove the current one.

const FRAME_HEADERS = [
  { header: 'X-Frame-Options', operation: 'remove' },
  { header: 'Content-Security-Policy', operation: 'remove' },
  { header: 'X-Content-Security-Policy', operation: 'remove' },
  { header: 'X-WebKit-CSP', operation: 'remove' },
];

// Serialize rule updates: get + update must not interleave between messages.
let ruleQueue = Promise.resolve();
function serial(fn) {
  const run = ruleQueue.then(fn);
  ruleQueue = run.catch(() => {});
  return run;
}

async function sessionRulesForTab(tabId) {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  return { all: rules, mine: rules.filter((r) => r.condition?.tabIds?.includes(tabId)) };
}

// ─── Preview frame tracking ──────────────────────────────────────────────────
// One preview per tab: { token, url, ruleId, frameId }. Kept in storage.session
// (plus an in-memory cache) because the service worker can be stopped while a
// preview is open. webNavigation events for that frame are relayed to the top
// frame — they report commits and blocked loads even where no content script runs.

const previewCache = new Map();
const previewKey = (tabId) => `preview:${tabId}`;

async function getPreview(tabId) {
  if (previewCache.has(tabId)) return previewCache.get(tabId);
  const key = previewKey(tabId);
  const p = (await chrome.storage.session.get(key))[key] ?? null;
  previewCache.set(tabId, p);
  return p;
}

async function setPreview(tabId, p) {
  previewCache.set(tabId, p);
  if (p) await chrome.storage.session.set({ [previewKey(tabId)]: p });
  else await chrome.storage.session.remove(previewKey(tabId));
}

function stripHash(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

chrome.webNavigation.onBeforeNavigate.addListener(async (d) => {
  if (d.frameId === 0 || d.parentFrameId !== 0) return;
  const p = await getPreview(d.tabId);
  if (!p || p.frameId != null || stripHash(d.url) !== stripHash(p.url)) return;
  await setPreview(d.tabId, { ...p, frameId: d.frameId });
});

async function relayNavigation(d, event, extra = {}) {
  if (d.frameId === 0) return;
  const p = await getPreview(d.tabId);
  if (!p || p.frameId !== d.frameId) return;
  await sendToTop(d.tabId, { type: 'frameEvent', token: p.token, frameId: d.frameId, event, url: d.url, ...extra });
}

// Tell the content script inside the preview frame that it is the preview (it
// reports title / history state and forwards Escape). DOMContentLoaded is after
// document_start scripts have registered their listeners, so the message lands.
chrome.webNavigation.onDOMContentLoaded.addListener(async (d) => {
  if (d.frameId === 0) return;
  const p = await getPreview(d.tabId);
  if (!p || p.frameId !== d.frameId) return;
  chrome.tabs.sendMessage(d.tabId, { type: 'previewHello', token: p.token }, { frameId: d.frameId })
    .catch(() => {});
});

chrome.webNavigation.onCommitted.addListener((d) => relayNavigation(d, 'committed'));
chrome.webNavigation.onErrorOccurred.addListener((d) => relayNavigation(d, 'error', { error: d.error }));
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => relayNavigation(d, 'url'));
chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => relayNavigation(d, 'url'));

function enablePreviewHeaders(tabId, url, token) {
  return serial(async () => {
    const { all, mine } = await sessionRulesForTab(tabId);
    const taken = new Set(all.map((r) => r.id));
    let id;
    do { id = 1 + Math.floor(Math.random() * 0x7ffffffe); } while (taken.has(id));
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: mine.map((r) => r.id), // only one preview per tab — drop stale rules
      addRules: [{
        id,
        priority: 1,
        action: { type: 'modifyHeaders', responseHeaders: FRAME_HEADERS },
        condition: { resourceTypes: ['sub_frame'], tabIds: [tabId] },
      }],
    });
    const u = validateHttpUrl(url);
    await setPreview(tabId, u && typeof token === 'string'
      ? { token, url: u.href, ruleId: id, frameId: null }
      : null);
    return { ok: true, ruleId: id };
  });
}

/** Remove one rule (if it belongs to the tab), or every rule for the tab when ruleId is omitted. */
function disablePreviewHeaders(tabId, ruleId) {
  return serial(async () => {
    const { mine } = await sessionRulesForTab(tabId);
    const ids = mine.map((r) => r.id).filter((id) => ruleId == null || id === ruleId);
    if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    const p = await getPreview(tabId);
    if (p && (ruleId == null || p.ruleId === ruleId)) await setPreview(tabId, null);
    return { ok: true };
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  disablePreviewHeaders(tabId).catch(() => {});
  previewCache.delete(tabId);
});

// ─── Opening links elsewhere ────────────────────────────────────────────────

function openPopup(url, m) {
  const availW = Number(m.screenAvailWidth) || 1280;
  const availH = Number(m.screenAvailHeight) || 800;
  const availL = Number(m.screenAvailLeft) || 0;
  const availT = Number(m.screenAvailTop) || 0;
  const width = Math.round(Math.min(availW * 0.8, 1400));
  const height = Math.round(Math.min(availH * 0.8, 900));
  return chrome.windows.create({
    url,
    type: 'popup',
    width,
    height,
    left: Math.round(availL + (availW - width) / 2),
    top: Math.round(availT + (availH - height) / 2),
    focused: true,
  });
}

function openTab(url, tab) {
  return chrome.tabs.create({
    url,
    active: true,
    ...(tab ? { index: tab.index + 1, openerTabId: tab.id, windowId: tab.windowId } : {}),
  });
}

// ─── Messages from content scripts ──────────────────────────────────────────

const handlers = {
  enablePreviewHeaders: (msg, tab) => enablePreviewHeaders(tab.id, msg.url, msg.token),

  disablePreviewHeaders: (msg, tab) =>
    disablePreviewHeaders(tab.id, Number.isInteger(msg.ruleId) ? msg.ruleId : undefined),

  async openPopup(msg) {
    const u = validateHttpUrl(msg.url);
    if (!u) return { ok: false, error: 'Invalid URL' };
    await openPopup(u.href, msg);
    return { ok: true };
  },

  async openTab(msg, tab) {
    const u = validateHttpUrl(msg.url);
    if (!u) return { ok: false, error: 'Invalid URL' };
    await openTab(u.href, tab);
    return { ok: true };
  },

  // A link in a sub-frame was triggered — the overlay always lives in the top frame.
  async openPreview(msg, tab) {
    const u = validateHttpUrl(msg.url);
    if (!u) return { ok: false, error: 'Invalid URL' };
    await sendToTop(tab.id, { type: 'showPreview', url: u.href, source: msg.source });
    return { ok: true };
  },

  // Preview iframe → top frame (ready / navigation / title / Escape).
  async frameEvent(msg, tab, sender) {
    // The preview's own script reporting in also identifies its frame.
    const p = await getPreview(tab.id);
    if (p && p.token === msg.token && p.frameId == null && sender.frameId > 0) {
      await setPreview(tab.id, { ...p, frameId: sender.frameId });
    }
    await sendToTop(tab.id, { ...msg, frameId: sender.frameId });
    return { ok: true };
  },

  // Top frame → preview iframe (history back / forward).
  async frameCommand(msg, tab) {
    if (!Number.isInteger(msg.frameId) || msg.frameId <= 0) return { ok: false };
    await chrome.tabs.sendMessage(tab.id, { type: 'frameCommand', token: msg.token, cmd: msg.cmd },
      { frameId: msg.frameId }).catch(() => {});
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  const tab = sender.tab;
  if (!handler || !tab || !isTabId(tab.id)) return false;
  Promise.resolve()
    .then(() => handler(message, tab, sender))
    .then(sendResponse, (err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});

// ─── Context menus ──────────────────────────────────────────────────────────

const MENU_PREVIEW = 'peeksy-preview-link';
const MENU_PAUSE = 'peeksy-pause';
const MENU_SETTINGS = 'peeksy-settings';

async function setupMenus() {
  const s = await Settings.load();
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_PREVIEW,
    title: 'Preview link with Peeksy',
    contexts: ['link'],
    targetUrlPatterns: ['http://*/*', 'https://*/*'],
  });
  chrome.contextMenus.create({
    id: MENU_PAUSE,
    title: 'Pause Peeksy everywhere',
    type: 'checkbox',
    checked: !s.enabled,
    contexts: ['action'],
  });
  if (IS_FIREFOX) {
    // Chrome already lists "Options" in the toolbar icon menu.
    chrome.contextMenus.create({ id: MENU_SETTINGS, title: 'Peeksy settings', contexts: ['action'] });
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_PAUSE) {
    await Settings.save({ enabled: !info.checked });
    return;
  }
  if (info.menuItemId === MENU_SETTINGS) {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (info.menuItemId === MENU_PREVIEW) {
    const u = validateHttpUrl(info.linkUrl);
    if (!u || !tab || !isTabId(tab.id)) return;
    const res = await sendToTop(tab.id, { type: 'showPreview', url: u.href, source: 'menu' });
    // No content script in the top frame (restricted page) — fall back to a popup window.
    if (!res?.ok) openPopup(u.href, {}).catch(() => {});
  }
});

// ─── Toolbar icon: opens the settings popup; badge shows OFF where inactive ─

chrome.action.setBadgeBackgroundColor({ color: '#5f6368' }).catch(() => {});

async function updateBadge(tab, s) {
  if (!tab || !isTabId(tab.id)) return;
  const host = hostOf(tab.url);
  let text = '';
  let title;
  if (!s.enabled) {
    text = 'OFF';
    title = 'Peeksy is paused everywhere';
  } else if (host && Settings.isSiteDisabled(host, s.disabledSites)) {
    text = 'OFF';
    title = `Peeksy is off on ${host}`;
  } else {
    title = 'Peeksy';
  }
  await Promise.all([
    chrome.action.setBadgeText({ tabId: tab.id, text }),
    chrome.action.setTitle({ tabId: tab.id, title }),
  ]).catch(() => {});
}

async function updateAllBadges() {
  const [s, tabs] = await Promise.all([Settings.load(), chrome.tabs.query({})]);
  await Promise.all(tabs.map((tab) => updateBadge(tab, s)));
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const [tab, s] = await Promise.all([chrome.tabs.get(tabId).catch(() => null), Settings.load()]);
  updateBadge(tab, s);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'loading') return;
  updateBadge(tab, await Settings.load());
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== Settings.AREA) return;
  if (changes.enabled) {
    chrome.contextMenus.update(MENU_PAUSE, { checked: changes.enabled.newValue === false })
      .catch(() => {});
  }
  if (changes.enabled || changes.disabledSites) updateAllBadges().catch(() => {});
});

// ─── Keyboard command: preview focused link / close preview ────────────────

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'preview-focused-link') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isTabId(tab.id)) return;
  const res = await sendToTop(tab.id, { type: 'command' });
  if (res?.handled) return;
  // Focus is inside a sub-frame — let whichever frame has focus handle it.
  chrome.tabs.sendMessage(tab.id, { type: 'previewFocusedLink' }).catch(() => {});
});

// ─── Install / startup ──────────────────────────────────────────────────────

/** Settings moved from storage.local to storage.sync in 1.2.0. */
async function migrateLocalSettings() {
  const keys = Object.keys(Settings.DEFAULTS);
  const local = await chrome.storage.local.get(keys);
  if (!Object.keys(local).length) return;
  const synced = await chrome.storage.sync.get(keys);
  if (!Object.keys(synced).length) await chrome.storage.sync.set(Settings.normalize(local));
  await chrome.storage.local.remove(keys);
}

/** Re-inject after reload/update — existing tabs keep dead listeners otherwise. */
async function reinjectContentScripts() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (!isTabId(tab.id) || !/^https?:/i.test(tab.url || '')) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['settings.js', 'content.js'],
      });
    } catch {
      /* restricted pages (chrome://, Web Store, etc.) */
    }
  }));
}

chrome.runtime.onInstalled.addListener(async () => {
  await migrateLocalSettings().catch(() => {});
  await setupMenus().catch(() => {});
  updateAllBadges().catch(() => {});
  reinjectContentScripts();
});

chrome.runtime.onStartup.addListener(() => {
  setupMenus().catch(() => {});
  updateAllBadges().catch(() => {});
});
