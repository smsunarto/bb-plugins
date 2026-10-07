# bb Monokai

- `CONTRACT.md` owns palette policy. BB's agent stream owns Markdown presentation. Docs and Canvas adapt the stream's rules, including theme overrides, rather than maintaining separate reading styles.
- Do not edit `themes/bb-monokai.css` or `themes/bb-monokai-code.json` by hand.
- Use Storybook for the palette catalog. Use live bb for shadow DOM and host selectors.
- Code theme tokens are inline styles in a shadow root. CSS cannot set them. The theme is dark only. Light stays on `pierre-light`.
- `sync:code-theme` is an authoring step. `check:code-theme` reports drift without writing. CI runs neither. The editor theme is a private sibling checkout.
- An unmapped hex stops the sync. Amend `CONTRACT.md` and the palette first.
- The generator owns palette policy. The template owns bb selector mechanics.
- Do not put rendered hexes in the template. Do not add a second palette registry.
- CSS comments are excluded. They document foreign upstream defaults.

## Diff header adapter

- `app/diff-header.ts` decorates BB's native Git headers through a content script. The public diff renderer slot owns only the body.
- Private contracts: the secondary panel's `thread-detail-secondary-panel` id prefix, the compact shelf's `data-testid="secondary-panel-shelf"`, the header's collapse-button structure, DOM `__reactFiber$` and `__reactProps$`, and the header `model` props (`path`, `label`, `changeKind`). Split panes suffix the panel id with a pane id, and the resize handle `#thread-detail-secondary-panel-handle` shares the prefix. `app/diff-header.css` repeats the `PANEL` scope from `diff-header.ts`, so change both together. Select the fiber by committed DOM props identity. A mounted row can have a stale parent return chain, so do not walk to the root to determine currency. Traversal is bounded and skips unknown models. Recheck these contracts after BB upgrades.
- Observe each filename once. Batch overflow reads before attribute writes, and ignore mutations outside headers. `test/diff-header.browser.ts` checks that page-wide mutations do not cause repeated header scans or layout reads. No script or CI job runs it. Run it by hand, as its header comment describes, after changing the observer or the tags.
- Style the diff shell through the tags the adapter sets: `data-monokai-diff-header` (the header row), `data-monokai-diff-shell` (its `.bg-background` wrapper), `data-monokai-diff-card` (a sticky card that holds bb's `.h-0` sentinel), and `data-monokai-diff-panel` (a secondary panel or shelf that shows `[data-testid="git-diff-toolbar-layout"]` or `[data-monokai-diff-surface]`). Any `:has()` rule makes each streamed DOM change re-check its subjects. `theme-contract.test.ts` rejects `:has()` in the theme and `diff-header.css`.
- Use Pierre's exported sprite for change-kind artwork and existing theme colors. Remove owned icons on theme deselection and disposal. Hide Open in Editor only in the secondary panel via its accessible label.

## Terminal adapter

- `app/terminal-appearance.ts` is the plugin-only bridge for BB releases that hardcode xterm typography. It reads the theme tokens, never a second font or color registry.
- The theme sets BB's own `--font-terminal` to `var(--terminal-font-family)`. BB reads it when it creates a terminal and resets the family to it on every theme change, so both tokens must name the same stack.
- The adapter is inert when the host already renders the `--terminal-*` typography tokens. After detecting matching host-owned typography, it bypasses further private traversal, fitting, refresh, and restore registration for that terminal.
- Private contracts: a DOM `__reactFiber$` attachment, React hook refs, xterm `_addonManager._addons[].instance`, and BB's `document.fonts` `loadingdone` listener. Find the terminal by exact `element` identity, and FitAddon by `_terminal` identity plus its `fit` and `proposeDimensions` methods. Do not depend on component names or hook indexes. FitAddon resizes only xterm. BB 0.45 sends the PTY its size only from its own fit, so the adapter dispatches one synthetic `loadingdone` after a reconcile or disposal that changes typography. Without that listener, the PTY keeps its old size until the next pane resize.
- Bound every traversal. Skip unrecognized terminals. Use xterm's public options and the existing FitAddon to resize. Restore only owned values on theme deselection, plugin reload, and disposal.
- The adapter tags each terminal's `.bg-sidebar.p-2` grandparent with `data-monokai-terminal-surface` for the theme's padding rule, whether or not the host owns typography. Verify it against an unmodified BB release before reloading live Monokai.

## Monaco adapter

- `app/monaco-syntax-tokens.ts` adds JavaScript and TypeScript semantic tokens on top of the code theme that BB's Monaco editor already applies. It acts only while `--bb-monokai-active` is `1`.
- Private contracts: BB's monaco-editor plugin injects `<base>/editor.css` and loads `<base>/editor.js` beside it, and that module exports `monaco`. The adapter finds the stylesheet link, imports the sibling module, and calls `monaco.editor.tokenize`, `getEditors`, `onDidCreateEditor`, and `monaco.languages.registerDocumentSemanticTokensProvider`. Recheck these contracts after BB upgrades.
- A DOM fallback colors `.monaco-editor .view-line` spans with the `!important` classes in `app/monaco-syntax-tokens.css`. It mounts whenever the theme is active. If BB renames or moves the bundle, the adapter attaches nothing, reports nothing, and only the fallback colors editors.
- `semanticHighlighting.enabled` lives in the configuration service that every standalone editor shares. Record the first value the theme replaces. Restore it on theme deselection, plugin reload, and disposal, even after every editor has closed.

## Palette-independent files

- `app/ui-font-bridge.ts` writes `--bb-monokai-ui-font` on `<html>`. Only the theme's `--font-sans` reads it, so the UI font setting does nothing under another palette.
- `app/secondary-panel-resize.css` registers `@property --secondary-swipe-width` whenever the plugin is enabled, under any palette. It is a BB performance fix, not theme styling. Delete it once the minimum BB version registers the property itself.
