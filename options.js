'use strict';

const Settings = globalThis.PeeksySettings;
const IS_FIREFOX = /firefox/i.test(navigator.userAgent);
const IS_POPUP = new URLSearchParams(location.search).has('popup');
const $ = (id) => document.getElementById(id);

if (IS_POPUP) document.documentElement.classList.add('popup');

/** Host of the active tab when shown as the toolbar popup ('' otherwise). */
let siteHost = '';

const SLIDERS = ['hoverDelay', 'overlayWidth', 'overlayHeight', 'defaultZoom', 'backdropOpacity'];
const TOGGLES = ['enabled', 'hoverPreview', 'backdropBlur'];

let current = Settings.normalize();

// ─── Toast ───────────────────────────────────────────────────────────────────

let toastTimer = null;
function showToast(text = 'Settings saved') {
  const toast = $('toast');
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

async function save(partial, toast) {
  try {
    await Settings.save(partial);
    showToast(toast);
  } catch (err) {
    showToast('Could not save: ' + err.message);
  }
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderSites() {
  const list = $('siteList');
  list.replaceChildren(...current.disabledSites.map((site) => {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn subtle small';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Turn Peeksy back on for ${site}`);
    remove.addEventListener('click', () => {
      save({ disabledSites: current.disabledSites.filter((s) => s !== site) }, `Peeksy is back on for ${site}`);
    });
    const name = document.createElement('span');
    name.textContent = site;
    const li = document.createElement('li');
    li.append(name, remove);
    return li;
  }));
  $('siteEmpty').hidden = current.disabledSites.length > 0;
}

function render(s) {
  current = s;
  for (const key of SLIDERS) {
    const input = $(key);
    if (document.activeElement !== input) input.value = s[key];
    $(key + 'Val').textContent = s[key];
  }
  for (const key of TOGGLES) $(key).checked = s[key];
  document.querySelectorAll('input[name="triggerKey"]').forEach((r) => {
    r.checked = r.value === s.triggerKey;
  });
  $('hoverDelayField').classList.toggle('disabled', !s.hoverPreview);
  $('hoverDelay').disabled = !s.hoverPreview;
  if (siteHost) $('siteEnabled').checked = !Settings.isSiteDisabled(siteHost, s.disabledSites);
  renderSites();
}

async function initSiteToggle() {
  if (!IS_POPUP) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || '');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    siteHost = Settings.normalizeHost(url.hostname);
  } catch {
    return;
  }
  if (!siteHost) return;
  $('siteName').textContent = siteHost;
  $('siteRow').hidden = false;
  $('siteEnabled').checked = !Settings.isSiteDisabled(siteHost, current.disabledSites);
}

async function renderShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === 'preview-focused-link');
    $('commandShortcut').textContent = cmd?.shortcut || 'Not set';
  } catch {
    $('commandShortcut').textContent = 'Unavailable';
  }
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

const saveTimers = {};
function debouncedSave(key, value) {
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => save({ [key]: value }), 400);
}

for (const key of SLIDERS) {
  const input = $(key);
  input.addEventListener('input', () => {
    $(key + 'Val').textContent = input.value;
    debouncedSave(key, Number(input.value));
  });
  input.addEventListener('change', () => {
    clearTimeout(saveTimers[key]);
    save({ [key]: Number(input.value) });
  });
}

for (const key of TOGGLES) {
  $(key).addEventListener('change', (e) => save({ [key]: e.target.checked }));
}

document.querySelectorAll('input[name="triggerKey"]').forEach((r) => {
  r.addEventListener('change', () => save({ triggerKey: r.value }));
});

$('siteForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('siteInput');
  const error = $('siteError');
  const host = Settings.normalizeHost(input.value);
  if (!host) {
    error.textContent = 'Enter a domain like example.com or paste a link.';
    error.hidden = false;
    input.focus();
    return;
  }
  error.hidden = true;
  input.value = '';
  if (!current.disabledSites.includes(host)) {
    save({ disabledSites: [...current.disabledSites, host] }, `Peeksy is off on ${host}`);
  }
});

$('changeShortcut').addEventListener('click', () => {
  if (IS_FIREFOX) {
    showToast('Firefox: Add-ons → ⚙ → Manage Extension Shortcuts');
  } else {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  }
});

$('siteEnabled').addEventListener('change', (e) => {
  if (!siteHost) return;
  const disabledSites = e.target.checked
    ? current.disabledSites.filter((site) => !Settings.siteMatches(siteHost, site))
    : [...current.disabledSites, siteHost];
  save({ disabledSites }, e.target.checked ? `Peeksy is on for ${siteHost}` : `Peeksy is off on ${siteHost}`);
});

$('openFull').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// Two-step reset (confirm() dialogs don't work well inside the toolbar popup).
let resetArmed = null;
$('reset').addEventListener('click', async () => {
  const btn = $('reset');
  if (!resetArmed) {
    btn.textContent = 'Click again to reset everything';
    btn.classList.add('danger');
    resetArmed = setTimeout(() => {
      resetArmed = null;
      btn.textContent = 'Reset to defaults';
      btn.classList.remove('danger');
    }, 4000);
    return;
  }
  clearTimeout(resetArmed);
  resetArmed = null;
  btn.textContent = 'Reset to defaults';
  btn.classList.remove('danger');
  await chrome.storage.sync.clear();
  await save({ ...Settings.DEFAULTS }, 'Settings reset');
});

// Keep the page in sync with changes made elsewhere (toolbar icon, overlay resize, other devices).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== Settings.AREA) return;
  const next = { ...current };
  for (const [key, { newValue }] of Object.entries(changes)) next[key] = newValue;
  render(Settings.normalize(next));
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) renderShortcut();
});

Settings.load().then(render, () => render(current)).then(initSiteToggle);
renderShortcut();
