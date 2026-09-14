# bb Monokai

- `CONTRACT.md` is the source of truth. Amend it before the bb adapter.
- Do not edit `themes/bb-monokai.css` or `themes/bb-monokai-code.json` by hand.
- Use Storybook for the palette catalog. Use live bb for shadow DOM and host selectors.
- Code theme tokens are inline styles in a shadow root. CSS cannot set them. The theme is dark only. Light stays on `pierre-light`.
- `sync:code-theme` is an authoring step. CI never runs it. The editor theme is a private sibling checkout.
- An unmapped hex stops the sync. Amend `CONTRACT.md` and the palette first.
- The generator owns palette policy. The template owns bb selector mechanics.
- Do not put rendered hexes in the template. Do not add a second palette registry.
- CSS comments are excluded. They document foreign upstream defaults.

## Diff header adapter

- `app/diff-header.ts` decorates BB's native Git headers through a content script. The public diff renderer slot owns only the body.
- Private contracts: the header's collapse-button structure, DOM `__reactFiber$` and `__reactProps$`, and the header `model` props (`path`, `label`, `changeKind`). Select the fiber by committed DOM props identity. A mounted row can have a stale parent return chain, so do not walk to the root to determine currency. Traversal is bounded and skips unknown models. Recheck these contracts after BB upgrades.
- Observe each filename once. Batch overflow reads before attribute writes, and ignore mutations outside headers. `test/diff-header.browser.ts` guards against page-wide mutations causing repeated header scans and layout reads.
- Use Pierre's exported sprite for change-kind artwork and existing theme colors. Remove owned icons on theme deselection and disposal. Hide Open in Editor only in the secondary panel via its accessible label.

## Terminal adapter

- `app/terminal-appearance.ts` is the plugin-only bridge for BB releases that hardcode xterm typography. It reads the theme tokens, never a second font or color registry.
- The adapter is inert when the host already renders the `--terminal-*` typography tokens. After detecting matching host-owned typography, it bypasses further private traversal, fitting, refresh, and restore registration for that terminal.
- Private contracts: a DOM `__reactFiber$` attachment, React hook refs, and xterm `_addonManager._addons[].instance`. Find the terminal by exact `element` identity, and FitAddon by `_terminal` identity plus its `fit` and `proposeDimensions` methods. Do not depend on component names or hook indexes.
- Bound every traversal. Skip unrecognized terminals. Use xterm's public options and the existing FitAddon to resize. Restore only owned values on theme deselection, plugin reload, and disposal.
- The padding selector is `.bg-sidebar:has(> div > .xterm)`. Verify it and the runtime adapter against an unmodified BB release before reloading live Monokai.
