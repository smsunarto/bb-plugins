# Kitchen Sink: phone touches

Kitchen Sink adds two phone-only behaviors. In BB's mobile app, a light haptic tap answers the moment a thread or new-thread composer starts sending. On a touch screen, tapping the nav rail's **Search threads** raises the keyboard with the caret in bb's thread search field, which iOS otherwise leaves closed. Neither draws anything on desktop.

## Sub-features

- `ks-send-haptic` posts a light impact haptic through BB's mobile app bridge when a thread or new-thread composer begins submitting; the device's **Settings → This device → Haptics** switch still applies.
- `ks-send-haptic-web` does nothing outside BB's mobile app.
- `ks-search-keyboard-reopen` refocuses bb's search input when the thread search drawer reopens on a coarse pointer.
- `ks-search-keyboard-first` holds focus in a hidden stand-in input on the drawer's first open, until bb's input takes focus or three seconds pass, so the keyboard stays up.
- `ks-search-keyboard-fine` leaves fine-pointer (mouse) clicks untouched.

## How to get to it (user POV)

- In BB's iOS or Android app, send a message from a thread or the New thread screen; the phone taps once as the send starts.
- On a phone browser or the mobile app, tap **Search threads** in the nav rail (or in the sidebar list navigation) when it is pinned there. The search drawer opens with the keyboard up. From the **More** menu, bb opens the drawer and focuses its input itself; the plugin does not act there.

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin kitchen-sink`.
- `ks-send-haptic` needs BB's mobile app on a device; its bridge exists nowhere else. Report the real haptic unreachable from the test browser, and send only on the free fake agent. The stub below tests only that a send calls the bridge, not that a phone vibrates.
- `ks-search-keyboard-*` needs a coarse pointer and a **Search threads** item pinned in the navigation (`__bb__/search-threads` in the UI preference `sidebar.visiblePluginPanels`). Live's mirrored navigation leaves it out, so it sits in the **More** menu, where the fix does not apply. Check with `"$TB" settings ui list --json | jq '.preferences["sidebar.visiblePluginPanels"].value | index("__bb__/search-threads")'`; `null` means the rail path is unreachable without changing a navigation setting, which a shared verifier must not do.
- Emulate a phone on a fresh session: open `"$URL"` there first, then `bun scripts/phone-shot.ts start iphone-17-pro-max --session "$RUN-phone"`. Whether iOS raises its keyboard shows only on a device; hand that off as "not verified on device".

- **Haptic, web.** On the desktop session, run `agent-browser --session "$RUN" eval 'typeof window.bb?.native?.post'`. It returns `"undefined"`, also in the phone-emulated session, so a send there posts nothing; `ks-send-haptic-web` holds by construction.
- **Haptic, stubbed bridge (mechanism only, free fake turn).** Open a thread whose provider is the local fake agent (SKILL.md **Free agent turns**; a thread spawned with `--provider acp-verify-fake` keeps that provider, and its composer shows `Agent default`). Run `agent-browser --session "$RUN" eval '(() => { window.__ksHaptics = []; window.bb = window.bb || {}; window.bb.native = Object.assign(window.bb.native || {}, { capabilities: ["haptic"], post: (m) => window.__ksHaptics.push(m) }); return true; })()'`, then `agent-browser --session "$RUN" focus '[contenteditable="true"]'`, `agent-browser --session "$RUN" keyboard type "haptic check"`, and `agent-browser --session "$RUN" press Enter`. Then `agent-browser --session "$RUN" wait --fn 'window.__ksHaptics.length > 0' --timeout 5000` and read `window.__ksHaptics`: it holds one `{"type":"haptic","kind":"impact-light"}`. `"$TB" thread log <id>` shows the `haptic check` message. Reload immediately afterwards to drop the stub. Label this evidence as a stub.
- **Coarse pointer.** In `$RUN-phone`, run `agent-browser --session "$RUN-phone" eval 'matchMedia("(pointer: coarse)").matches + " w=" + innerWidth'`, which returns `"true w=440"`. List the navigation handles with `agent-browser --session "$RUN-phone" eval '[...document.querySelectorAll("[data-nav-rail-item], [data-sidebar-navigation-item]")].map(e => e.getAttribute("data-nav-rail-item") || e.getAttribute("data-sidebar-navigation-item"))'`. On the phone layout bb uses list navigation (`[data-sidebar-navigation-item]`, no rail); `__bb__/search-threads` is in the list only when pinned.
- **Install a focus log.** `agent-browser --session "$RUN-phone" eval '(() => { window.__ksFocus = []; document.addEventListener("focusin", e => window.__ksFocus.push(e.target.hasAttribute("data-kitchen-sink-keyboard-stand-in") ? "stand-in" : (e.target.matches("[data-testid=\"command-palette\"] input[role=\"combobox\"]") ? "search-input" : e.target.tagName + "." + (e.target.getAttribute("role") || ""))), true); return true; })()'`.
- **More-menu path (not covered by the fix).** Open the sidebar with `agent-browser --session "$RUN-phone" find role button click --name "Toggle sidebar"`, choose `find role button click --name "More"`, then `find role menuitem click --name "Search threads"`. The search drawer opens with placeholder `Search title, project, or message...`. `window.__ksFocus` reads `["BUTTON.menuitem","BUTTON.","DIV.dialog","search-input"]`: bb focuses its own input on this path, and no `stand-in` entry appears. Capture with `bun scripts/phone-shot.ts shot --session "$RUN-phone" --out "$EV/ks-search-more"`.
- **First open from the rail item.** Tap the pinned item with `agent-browser --session "$RUN-phone" click '[data-nav-rail-item="__bb__/search-threads"], [data-sidebar-navigation-item="__bb__/search-threads"]'`. Then `agent-browser --session "$RUN-phone" wait --fn 'document.activeElement?.matches("[data-testid=\"command-palette\"] input[role=\"combobox\"]")' --timeout 5000`. Read `window.__ksFocus`: on a first open it shows `"stand-in"` before `"search-input"`, and `agent-browser --session "$RUN-phone" eval '!!document.querySelector("[data-kitchen-sink-keyboard-stand-in]")'` returns `false` afterwards. <!-- unverified: Search threads is not pinned in live's mirrored navigation -->
- **Reopen.** Close the drawer with `Escape` or its close control, clear the log, and tap the item again. The search input is focused at the end of the tap, with no `"stand-in"` entry. <!-- unverified: same prerequisite -->
- **Fine pointer.** On the desktop session, open search the same way. The log shows no `"stand-in"` entry and the plugin changes nothing. <!-- unverified: same prerequisite -->
- **Proof.** Save each focus log to `$EV/ks-search-<state>.txt` and capture `bun scripts/phone-shot.ts shot --session "$RUN-phone" --out "$EV/ks-search-open"`.
- **Cleanup.** Run `bun scripts/phone-shot.ts stop --session "$RUN-phone"` and `agent-browser --session "$RUN-phone" close`.

## Gotchas

- The search fix is a registered bb workaround that depends on bb's nav rail item, drawer panel, placeholder, and command-palette input. If the probe fails after a bb upgrade, check whether bb now focuses its input itself before reporting a gap.
- Emulation ends when the `phone-shot.ts` holder detaches, and a new tab is not emulated. Keep the phone checks in one tab.
- Desktop compact layouts with a mouse are fine-pointer; the search fix stays off there by design.
- The fix listens only for a click on the pinned navigation item. Live's navigation (mirrored to the test instance) keeps **Search threads** under **More**, so the fix never runs for this user's layout; pinning it changes a shared navigation setting.
- `phone-shot.ts start` must run after the session has a page open; it emulates the current page only.
- The haptic stub replaces bb's own mobile-bridge global, which bb's web app also reads. Run nothing else on that page before reloading.
