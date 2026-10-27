# Peeksy

A Chrome extension that lets you **ALT+click any link** to preview the page in a floating overlay — without leaving the current tab.

## Features

- **In-page overlay preview** — Links open in a centered floating panel with a dimmed, optionally blurred backdrop.
- **Configurable trigger** — Default is `Alt` + click; also supports `Alt+Shift` or `Alt+Ctrl`.
- **Open options from the overlay** — Jump to the link in the current tab, a new tab, or a popup window.
- **Customizable appearance** — Adjust overlay size, default zoom, backdrop opacity, and blur.
- **Frame-friendly** — While a preview is open, declarative net request rules strip `X-Frame-Options` and CSP headers for subframes **on that tab and host only** (not every iframe in the browser).
- **Keyboard support** — Press `Escape` to close; click outside the overlay to dismiss.
- **Embed fallback** — If a site still blocks embedding, the overlay shows a clear message with open-elsewhere actions.

## Installation

### From source (developer mode)

1. Clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.

The extension is ready to use on all sites.

## Usage

1. Hold your configured modifier key (default: **Alt**).
2. **Click** any `http` or `https` link.
3. The page opens in the overlay. Use the action buttons to open it elsewhere, or press **Escape** / click outside to close.

Click the extension toolbar icon to open **Settings**.

## Settings

| Option | Description |
|--------|-------------|
| Overlay width / height | Size as a percentage of the viewport (30–100%) |
| Default zoom | Fit-to-width scale multiplier (25–200%; 100% = page width matches overlay) |
| Trigger shortcut | `Alt`, `Alt+Shift`, or `Alt+Ctrl` |
| Backdrop opacity | Darkness behind the overlay (0–80%) |
| Backdrop blur | Frosted-glass effect on the backdrop |

Settings are saved automatically to `chrome.storage.local`.

## Project structure

```
Peeksy/
├── manifest.json      # Extension manifest (Manifest V3)
├── background.js      # Service worker (popup window + scoped DNR rules)
├── content.js         # Overlay UI and ALT+click handling
├── options.html       # Settings page
├── options.css
├── options.js
└── icons/             # Extension icons (16, 48, 128 px)
```

## Permissions

| Permission | Why |
|------------|-----|
| `storage` | Persist user settings |
| `scripting` | Re-inject the content script into open tabs after extension reload |
| `declarativeNetRequestWithHostAccess` | Temporarily remove frame-blocking headers for the preview iframe |
| `<all_urls>` | Inject the content script and apply net request rules on any site |

## Development

This is a plain JavaScript extension with no build step. Edit the source files and click **Reload** on `chrome://extensions` to test changes.

**Notes:**

- Link preview intercepts `mousedown` (not `click`) so Chrome’s native “Alt+click = Save link as” behavior does not take over on Windows.
- Only `http:` and `https:` URLs are previewable; `mailto:`, `javascript:`, and similar schemes are ignored.
- Header stripping is active only while a Peeksy preview is open, and only for subframes on that tab matching the preview host.
- Some sites still block embedding for other reasons (e.g. `frame-ancestors` in CSP delivered via meta tags). Peeksy shows a fallback panel in that case.
- Previews are not available for links inside page iframes (content script runs in the top frame only).
- Prefer **Alt+Ctrl** over OS-level Win-key combos; Windows often swallows Alt+Win before the page receives the click.
- Preview iframes use `allow-scripts` and `allow-same-origin` so real sites (cookies, storage) can render. That combination weakens sandbox isolation inside the preview tab by design.

## License

No license file is included yet. All rights reserved unless otherwise stated.
