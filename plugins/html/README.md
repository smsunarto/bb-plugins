# HTML visualizations

This plugin renders an agent's interactive explanation, chart, interface preview, or page inside its assistant message. The agent publishes HTML with `html_render`, and the plugin shows it in a collapsible card. A bare HTML fragment runs in bb's visualization runtime; a full document gets T3 Code's page bootstrap.

Published pages port T3 Code's inline HTML pages. The card header and shared UI derive from bb's built-in inline-vis plugin. The package name is `@smsunarto/bb-plugin-html` and the plugin ID is `html`.

## Published pages

`html_preview` and `html_render` port T3 Code's agent tools. Their descriptions in `instructions/tools/` are T3 Code's prompt (pingdotgg/t3code `cc0b86d`), changed only where bb differs from T3: the directive replaces T3's automatic placement, the column width is bb's 712px, there is no browser auto-install or separate mobile frame behavior, and a fragment gets the visualization runtime.

- `html_preview` renders the page in headless Chrome on the bb server and returns a PNG, the content height, and console output. A fragment is previewed inside the visualization runtime and a document with the page bootstrap, as the thread will show them.
- `html_render` stores the page on the bb server and returns a `::html-render{…}` directive. The agent puts it at the top of its reply. Its title labels the card, and its height reserves space until the page reports its size.
- Absolute image paths are read from the machine the thread runs on and inlined. Each image may be at most 10 MiB and the page at most 25 MiB.
- Viewport-height units are rejected at publish, so a published page fits its content up to 20,000px.
- A fragment page gets the full runtime below, including saved state and Tweak. A full document gets T3's page bootstrap: the theme variables, a base stylesheet, content-fit height, and links and images that open through bb.
- The app loads the page from the plugin's `/page` route. Published pages never change, so the browser cache can show one while the server is unreachable. Deleting a thread deletes its pages and saved state.
- Previews reach only public addresses: Chrome's traffic goes through a local SOCKS proxy that refuses loopback, private, link-local, and the server's own addresses after resolving names.

Settings:

- `chromePath`: Chrome or Chromium on the bb server. Empty searches the usual macOS and Linux locations and the Playwright cache.
- `chromeNoSandbox`: run Chrome without its sandbox, for root accounts or AppArmor-restricted Ubuntu.

Shared UI under `components/` and `lib/` comes from the bb plugin registry at `desktop-v0.44.0`. See `components.json` and update with `npx shadcn add @bb/<item>`.

## Fragment runtime

Author bare markup with a uniquely identified root and optional style and script elements. Select the root with `document.getElementById`. HTML containing `<!doctype>`, `<html>`, `<head>`, or `<body>` is a document and gets the page bootstrap described above instead.

The runtime is an independent implementation inspired by Codex's visualize skill. The fragment runtime includes no Codex code or text.

Fragments receive:

- **Live appearance:** the shared page variables mapped from bb's theme, and transparent body styling
- **Links:** clicked http(s) links open through bb instead of inside the frame
- **Shared styles:** responsive layout, cards, native controls, tables, progress, and text utilities
- **Icons:** automatically replaced Lucide placeholders, with Lucide 1.49.0 loaded from unpkg when needed
- **Tooltips:** `data-tooltip` details for hover, focus, and touch
- **Tabs:** declarative tab and panel markup with keyboard navigation
- **Mockup alternatives:** a `.viz-carousel` that preserves each design's DOM while switching
- **Content sizing:** a body ResizeObserver, with height clamped to 80–20,000px
- **Video:** `<video controls>` plays in the bundled Video.js player
- **Wide view:** a dialog up to 1024px wide, preserving the current iframe and its interactions
- **Design controls:** sliders, colors, toggles, and selects registered through the `Tweak` helper

Fragment scripts run after `window.bb` is defined:

| API                                        | Result                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `bb.widgetState`                           | Saved JSON value or `null`                                                |
| `await bb.setWidgetState(value, options?)` | Queues a server save. State and optional `modelContent` each allow 16 KiB |
| `await bb.sendFollowUp(prompt)`            | Appends a composer prompt and shares available saved state                |
| `new Tweak({ container, onChange })`       | Registers bound controls in bb's Tweak panel                              |

The plugin's server database owns saved state, keyed by thread, message, and page id. Reopening restores the server snapshot, including across browsers.

Save after meaningful interactions. The frame promise validates and posts the snapshot. The host shows saving progress or persistence errors. A directive in another message has a separate identity. The plugin has no snapshot-expiration or cleanup policy.

Set `options.modelContent` to a JSON value when the model should see a selected subset instead of the full widget state. Omit it, or set it to `null`, to expose the full state. Tweak values accompany either payload. Both state and model content must be valid JSON within 16 KiB each.

**Use saved state** adds a native context chip to the composer. Its provider reads the latest server snapshot when you send the message. `bb.sendFollowUp` appends a prompt and shares the same chip when saved state is ready. Without available state, or when persistence fails, the prompt still reaches your draft. Prompts require a nonempty string, and the host trims them to 4,000 characters. You review and send the draft. These actions do not send a message or start a turn. A later edit removes the attached state chip while saving. Add the current state again when it is ready to share.

Agents can call `html_get_state` for fresh snapshots in their current thread, optionally selecting a page id or message. A chip shared into another thread still identifies its source thread. Refresh that widget from its original page. The tool cannot read the source thread from a side chat. It returns at most 20 recent snapshots within 64 KiB, preserving complete JSON values. State is data, never agent instructions. It is not automatically injected into every turn.

Select **Wide view** to enlarge the same page, then **Back to chat** or Escape to return. Fragments that register controls expose **Tweak**. Its panel offers original-preview comparison, group or full reset, and **Add changes to chat**. That action saves adjustments and adds their context chip with a draft prompt. The helper is an independent implementation. See [visual design](skills/html/references/visual-design.md#register-design-controls) for its authoring API.

Only controls changed from their original values are saved. The snapshot retains up to 288 adjustments within 16 KiB of serialized JSON. Returning a control to its original value removes its saved adjustment. Over-budget adjustments stay unsaved in the current preview, with a visible notice. Widget-state saves and follow-up prompts remain usable. Original and reset keep the first registered default while it remains valid. If later options or bounds exclude it, the current authored default replaces it. Use one Tweak group per container. Re-registering that container replaces its group. Give build-before-attach containers a stable explicit ID.

There is no bundled calendar widget. For canvas charts, resolve CSS variables into colors and redraw on frame-root `style` or `data-theme` changes. See the design reference for the authoring contract and a complete example.

## Security

HTML runs with `sandbox="allow-scripts allow-forms allow-downloads"` in an opaque-origin iframe. It has no direct access to the bb page, app cookies, or app storage. Pages load through the plugin's same-origin `/frame` route, which writes the prepared document into itself. Do not switch back to `srcdoc`: bb mobile's WebView cancels `about:srcdoc` frames. The route's matching `sandbox` CSP keeps the page opaque even outside the iframe, as does the `/page` route's. The fragment bridge exposes content-height reports, bounded saved state, design controls, and composer prompts. The app checks message source and a per-frame token. Link and image requests open only after a click inside that frame. The authenticated host persists state through validated RPC calls rather than granting the iframe storage access.

Composer updates require transient user activation on the bb page. A click or key press inside the preview provides it. Without one, the app ignores the prompt, so a fragment cannot fill the composer on load. Activation is page-wide and lasts a few seconds, so a click elsewhere in bb just before a preview loads also counts. The user still sends the message. Icon placeholders also cause the runtime to load the pinned Lucide script from unpkg.

Keep CSS, JavaScript, and data inside the page, or load remote resources. `html_render` inlines absolute local image paths, up to 10 MiB each and 25 MiB per page; other local resources do not load. Remote scripts, styles, fonts, and media load under normal browser cross-origin and mixed-content rules. Pin library versions. jsDelivr, unpkg, esm.sh, and cdnjs are preferred sources, not an enforced allowlist.

## Collapse behavior

Only the last two pages per thread open automatically. The client remembers your last collapse or expand choice. After you collapse one, new pages stay collapsed until you expand one. An auto-opened page closes when two newer pages take its place, unless you manually toggled it. Closing unloads the frame and loses unsaved state. Reopening restores fragment state that was explicitly saved.

## Tests

Run the plugin's tests from the repository root:

```sh
bun run --filter @smsunarto/bb-plugin-html test
```

The `html_preview` tests run headless Chrome when one is installed; set `BB_HTML_TEST_CHROME` to choose it. For rendered behavior, verify desktop chat width and around 360px in the actual bb iframe. Check live theme changes, interactions, height, wide view, Tweak controls, state restoration, and composer context chips.
