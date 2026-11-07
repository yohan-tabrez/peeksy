# Peeksy

A browser extension that lets you **ALT+click any link** to preview the page in a floating overlay — without leaving the current tab.

## Features

- **In-page overlay preview** — Links open in a floating panel with a dimmed, optionally blurred backdrop.
- **Preview toolbar** — Page title and current URL, back / forward / reload, copy link, open in this tab / a new tab / a popup window, and close. The open actions use the page you navigated to inside the preview, not just the original link.
- **Move and resize** — Drag the toolbar to move the preview, drag the bottom-right corner to resize it (the size is remembered), double-click the toolbar to re-center.
- **Several ways to trigger** — `Alt`, `Alt+Shift` or `Alt+Ctrl` + click; optional hover-to-preview with a delay; a right-click **Preview link with Peeksy** menu item; and a keyboard shortcut (default `Alt+Shift+P`) that previews the focused link or closes the open preview.
- **Works in iframes** — Links inside embedded frames open the preview in the main page.
- **Settings popup** — Click the toolbar icon for a compact settings panel, including an **On this site** switch. The icon shows an `OFF` badge where Peeksy is turned off or paused.
- **Reliable embed detection** — If a site still can't be shown (or times out), the overlay shows a clear message with try-again and open-elsewhere actions.
- **Keyboard and screen-reader friendly** — `Escape` closes the preview even when focus is inside it; focus stays inside the dialog and returns to where it was on close; visible focus rings.
- **Settings sync** across your signed-in browsers (`chrome.storage.sync`), with light and dark themes on the settings page.

## Installation (developer mode)

Works in Chrome and other Chromium browsers (Edge, Brave).

1. Clone this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the project folder.

## Usage

1. Hold your configured modifier key (default: **Alt**) and **click** any `http`/`https` link — or right-click it and choose **Preview link with Peeksy**.
2. Use the toolbar to navigate, copy the link, or open it elsewhere.
3. Press **Escape**, click the **×**, or click outside the preview to close it.

Click the toolbar icon to open the settings popup (use **On this site** to turn Peeksy off for the current site, or **Full page** for the settings tab). Right-click the icon for **Pause Peeksy everywhere** and **Options**.

## Settings

| Option | Description |
|--------|-------------|
| Enable Peeksy | Pause or resume everywhere |
| Click shortcut | `Alt`, `Alt+Shift`, or `Alt+Ctrl` + click |
| Preview on hover / Hover delay | Open a preview after resting on a link (200–2000 ms) |
| Keyboard shortcut | Change it at `chrome://extensions/shortcuts` |
| Overlay width / height | Size as a percentage of the viewport (30–100%); also updated when you resize a preview |
| Default zoom | Fit-to-width scale multiplier (25–200%; 100% = a ~1280px-wide layout fills the overlay) |
| Backdrop opacity / blur | Darkness and frosted-glass effect behind the overlay |
| Turned off on these sites | Hostnames where triggers are ignored (subdomains included) |

## Project structure

```
Peeksy/
├── manifest.json      # Manifest V3
├── settings.js        # Shared settings schema, defaults, validation, site matching
├── background.js      # Header rules, context menus, toolbar toggle, shortcut, message relay
├── content.js         # Triggers (all frames), preview-frame reporting, overlay UI (top frame)
├── options.html       # Settings page (also the toolbar popup via options.html?popup)
├── options.css
├── options.js
└── icons/
```

## Permissions

| Permission | Why |
|------------|-----|
| `storage` | Persist and sync settings |
| `contextMenus` | "Preview link with Peeksy" and the toolbar icon menu |
| `webNavigation` | Know when the preview frame loaded, failed, or navigated (drives the fallback panel and the toolbar URL) |
| `scripting` | Re-inject the content script into open tabs after the extension reloads |
| `declarativeNetRequestWithHostAccess` | Temporarily remove frame-blocking headers while a preview is open |
| `<all_urls>` | Run the content script and apply header rules on any site |

## How it works / caveats

- **Header stripping.** While a preview is open, a session rule removes `X-Frame-Options` and `Content-Security-Policy` from sub-frame responses **in that tab only**, and it is removed when the preview closes, the page navigates away, or the tab closes. It isn't limited to the previewed host, so redirects work — but any other iframe the page loads during that time is affected too. Because the declarative API can't edit a header, the whole CSP is removed, not just `frame-ancestors`: the previewed page runs without its own CSP protections inside the preview.
- **Embed detection.** The background tracks the preview frame with `webNavigation`: a committed page means success, a navigation error (e.g. `ERR_BLOCKED_BY_RESPONSE`) means the site can't be shown. Same-origin previews are also checked directly, and the content script inside the preview reports in with its title and history state. Only if none of these signals arrive does the overlay fall back after the frame's `load` event.
- **Sandbox warning.** Chrome logs "An iframe which has both allow-scripts and allow-same-origin… can escape its sandboxing" for every preview, and it shows up on the extension's Errors page. It's informational. The sandbox stays because it stops previewed pages from navigating your tab away (frame-busting).
- **Logged-out previews.** The preview is a third-party frame, so cookies marked `SameSite=Lax/Strict` aren't sent and third-party cookie blocking applies. Many sites will look logged-out in the preview — use **New tab** for those.
- **Sandbox.** The preview iframe uses `allow-scripts` and `allow-same-origin` so real sites render. A previewed page on the *same origin* as the current tab could lift its own sandbox — acceptable for a user-initiated preview, but don't treat the overlay as an isolation boundary.
- **History.** Navigating inside a preview adds entries to the tab's session history, as any iframe does. Back/forward buttons only appear active for history the preview can navigate itself.
- **Trigger timing.** Links are intercepted on `mousedown` (not `click`) so Chrome's native Alt+click "Save link as" never fires.
- On Linux, many window managers grab `Alt`+click before the browser sees it — use the context menu, the keyboard shortcut, or another modifier combination.
- Only `http:` and `https:` links are previewable.

## Development

Plain JavaScript, no build step. Edit the files and click **Reload** on `chrome://extensions` (open tabs get the new content script automatically).

## License

MIT — see [LICENSE](LICENSE).
