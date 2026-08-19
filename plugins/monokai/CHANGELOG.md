# @smsunarto/bb-plugin-monokai

## 0.3.0

### Minor Changes

- 36c1a79: Paint the syntax tokens. Diffs and file previews were the one surface the
  palette could not reach — Shiki writes an inline style on every span inside a
  shadow root — so they stayed on bb's `pierre-dark` while everything around them
  was Monokai. bb 0.38 added `bb.themes[].codeTheme`, which picks the Shiki theme
  instead of trying to restyle its output, and the plugin now ships one:
  `themes/bb-monokai-code.json`, the same TextMate layer as the Cursor Monokai
  editor theme. Pink machinery, cyan structure, green callables, yellow literals,
  purple constants, gray commentary, white for everything else.

  Dark only, like the palette: light mode keeps `pierre-light`.

  The scope map is vendored as roles rather than hexes, so the palette in
  `scripts/generate-theme.ts` stays the single registry, and the generator now
  also rejects a syntax token wearing a chrome-only role.

### Patch Changes

- 55e968e: Fix the code fences in chat messages, which were still bb's blue, red and
  green. The theme sets the sugar-high variables on `.dark .bb-code-highlight`,
  and so does bb — from a chunk that only loads once a thread is open. Equal
  specificity, later sheet wins, so the palette held until the first thread
  opened and lost from then on. Repeating the class outranks it.

  Six variables were affected: keyword, string, class, property, entity, and
  jsxliterals. Identifier, sign and comment were never overridden and looked
  right, which is what made the break read as intentional.

## 0.2.0

### Minor Changes

- b3ed493: Require bb 0.38 and take the SDK types from the published `@get-bb/plugin-sdk`
  package. `engines.bb` is now `>=0.38.0 <0.39.0`, so an older bb no longer
  installs these plugins.

  Agent Proxy gains a `routingStrategy` setting (`round-robin`, `fill-first`, or
  `weighted-round-robin`) that it writes to the core `config.yaml`. Pick
  `fill-first` to keep several Claude OAuth accounts from rotating away the
  upstream prompt cache.

- 65ececd: Release the runtime, presentation, notification, theme, and thread workflow updates.
