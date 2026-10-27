'use strict';

const FRAME_HEADERS = [
  { header: 'X-Frame-Options', operation: 'remove' },
  { header: 'Content-Security-Policy', operation: 'remove' },
  { header: 'X-Content-Security-Policy', operation: 'remove' },
  { header: 'X-WebKit-CSP', operation: 'remove' },
];

function validateHttpUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

async function enablePreviewHeaders(tabId, url) {
  const u = validateHttpUrl(url);
  if (!u || !Number.isInteger(tabId) || tabId < 0) {
    return { ok: false, error: 'Invalid tab or URL' };
  }

  // Domain + tab scoped while preview is open (covers same-host redirects).
  const ruleId = tabId + 1; // rule ids must be >= 1
  const host = u.hostname.replace(/[*|^]/g, '');
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId,
      priority: 1,
      action: { type: 'modifyHeaders', responseHeaders: FRAME_HEADERS },
      condition: {
        urlFilter: '||' + host,
        resourceTypes: ['sub_frame'],
        tabIds: [tabId],
      },
    }],
  });
  return { ok: true, ruleId };
}

async function disablePreviewHeaders(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return { ok: false, error: 'Invalid tab' };
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId + 1],
  });
  return { ok: true };
}

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

/** Re-inject after reload/update — existing tabs keep a dead install marker otherwise. */
async function reinjectContentScripts() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || !tab.url || !/^https?:/i.test(tab.url)) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
    } catch {
      /* restricted pages (chrome://, Web Store, etc.) */
    }
  }));
}

chrome.runtime.onInstalled.addListener(() => {
  reinjectContentScripts();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'enablePreviewHeaders') {
    const tabId = sender.tab?.id;
    enablePreviewHeaders(tabId, message.url)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'disablePreviewHeaders') {
    const tabId = sender.tab?.id;
    disablePreviewHeaders(tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type !== 'openPopup') return;

  const { url, screenAvailLeft, screenAvailTop, screenAvailWidth, screenAvailHeight } = message;

  const u = validateHttpUrl(url);
  if (!u) {
    sendResponse({ ok: false, error: 'Invalid URL' });
    return;
  }
  const safeUrl = u.href;

  const availW = Number(screenAvailWidth) || 1280;
  const availH = Number(screenAvailHeight) || 800;
  const availL = Number(screenAvailLeft) || 0;
  const availT = Number(screenAvailTop) || 0;

  const popupW = Math.round(Math.min(availW * 0.8, 1400));
  const popupH = Math.round(Math.min(availH * 0.8, 900));
  const left   = Math.round(availL + (availW - popupW) / 2);
  const top    = Math.round(availT + (availH - popupH) / 2);

  chrome.windows.create({
    url: safeUrl,
    type: 'popup',
    width: popupW,
    height: popupH,
    left,
    top,
    focused: true,
  })
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true;
});
