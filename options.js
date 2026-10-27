'use strict';

const DEFAULTS = {
  overlayWidth:    80,
  overlayHeight:   80,
  defaultZoom:    100,
  triggerKey:   'alt',
  backdropOpacity: 48,
  backdropBlur:  true,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const els = {
  overlayWidth:     document.getElementById('overlayWidth'),
  overlayWidthVal:  document.getElementById('overlayWidthVal'),
  overlayHeight:    document.getElementById('overlayHeight'),
  overlayHeightVal: document.getElementById('overlayHeightVal'),
  defaultZoom:      document.getElementById('defaultZoom'),
  defaultZoomVal:   document.getElementById('defaultZoomVal'),

  backdropOpacity:  document.getElementById('backdropOpacity'),
  backdropOpacityVal: document.getElementById('backdropOpacityVal'),
  backdropBlur:     document.getElementById('backdropBlur'),
  toast:            document.getElementById('toast'),
};

// ─── Persist ──────────────────────────────────────────────────────────────────

function readForm() {
  return {
    overlayWidth:    parseInt(els.overlayWidth.value, 10),
    overlayHeight:   parseInt(els.overlayHeight.value, 10),
    defaultZoom:     parseInt(els.defaultZoom.value, 10),
    triggerKey:      document.querySelector('input[name="triggerKey"]:checked')?.value ?? 'alt',
    backdropOpacity: parseInt(els.backdropOpacity.value, 10),
    backdropBlur:    els.backdropBlur.checked,
  };
}

let saveTimer = null;
let toastTimer = null;

function showToast() {
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

function debouncedSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

function save() {
  chrome.storage.local.set(readForm(), () => {
    if (chrome.runtime.lastError) return;
    showToast();
  });
}

// ─── Populate from storage ────────────────────────────────────────────────────

chrome.storage.local.get(DEFAULTS, (stored) => {
  if (chrome.runtime.lastError || !stored) return;

  // Migrate removed Alt+Win/⌘ trigger to Alt+Ctrl
  if (stored.triggerKey === 'altMeta') {
    stored.triggerKey = 'altCtrl';
    chrome.storage.local.set({ triggerKey: 'altCtrl' });
  }

  els.overlayWidth.value        = stored.overlayWidth;
  els.overlayWidthVal.textContent = stored.overlayWidth;

  els.overlayHeight.value        = stored.overlayHeight;
  els.overlayHeightVal.textContent = stored.overlayHeight;

  els.defaultZoom.value        = stored.defaultZoom;
  els.defaultZoomVal.textContent = stored.defaultZoom;

  els.backdropBlur.checked  = stored.backdropBlur;

  els.backdropOpacity.value        = stored.backdropOpacity;
  els.backdropOpacityVal.textContent = stored.backdropOpacity;

  document.querySelectorAll('input[name="triggerKey"]').forEach((r) => {
    r.checked = r.value === stored.triggerKey;
  });
});

// ─── Event wiring ─────────────────────────────────────────────────────────────

// Sliders: update live display + debounced save while dragging, immediate save on release
function bindSlider(inputEl, displayEl) {
  inputEl.addEventListener('input', () => {
    displayEl.textContent = inputEl.value;
    debouncedSave();
  });
  inputEl.addEventListener('change', save);
}

bindSlider(els.overlayWidth,    els.overlayWidthVal);
bindSlider(els.overlayHeight,   els.overlayHeightVal);
bindSlider(els.defaultZoom,     els.defaultZoomVal);
bindSlider(els.backdropOpacity, els.backdropOpacityVal);

// Checkboxes + radios: save on change
els.backdropBlur.addEventListener('change', save);
document.querySelectorAll('input[name="triggerKey"]').forEach((r) => {
  r.addEventListener('change', save);
});
