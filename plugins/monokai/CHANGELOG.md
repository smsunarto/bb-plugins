# @smsunarto/bb-plugin-monokai

## Unreleased

### Minor Changes

- Add a UI font setting with Inter as the default and SF Pro as the alternative.
  The selection updates every open mobile and desktop bb client without a
  plugin reload. Code and terminal typography remain on Berkeley Mono.

### Patch Changes

- Style bb's in-app notification center with Monokai surfaces, selected and
  hover states, controls, dividers, and a rounded desktop card. Refine desktop
  transient toasts with a compact Codex-inspired layout. Compact layouts keep
  bb's native drawer and toast geometry.

- Keep Monaco on the Cursor code contract. JavaScript and TypeScript lexical
  fallbacks no longer spend VS Dark teal or pale green on ambiguous identifiers
  and numbers. A syntax-derived token layer now recovers declaration keywords,
  types, function declarations and calls, plus parameter declarations and
  references without loading TypeScript language services. Bracket depth uses
  the Cursor palette instead of VS Dark. Existing Monokai pages activate the
  token layer immediately after a plugin reload. Desktop clients retain a DOM
  token fallback when Electron cannot attach the Monaco provider.

- Keep the page header on the editor ground. bb paints the header with its
  scrim surface, which the theme had pinned to the darker chrome ground, so
  on phones the header rendered one step darker than the status-bar strip
  above it and the content below it.

- Keep SF Pro composer placeholders at regular weight on mobile layouts.

- Gate every theme hover fill behind `@media (hover: hover)`, matching bb's
  own Tailwind hover utilities, so a tapped button on a phone no longer keeps
  its raised hover fill until the next tap.

- Tighten `diagram` and `patch` fence leading to 1.2 on compact
  coarse-pointer layouts, where bb raises thread code to 14px and the 1.3
  leading splits box-drawing connectors again.

- Keep the composer editor, the thread search field, and other text fields at
  16px on compact coarse-pointer layouts so iOS Safari does not zoom the page
  when a field takes focus.

- Set fenced code block leading in the thread to 1.5 instead of the host's
  prose leading, and tighten `diagram` and `patch` fences to 1.3 so
  box-drawing glyphs in file trees and tree diffs connect between rows.

- Frame inline images so they no longer blend into the panel. Markdown images,
  attachment thumbnails, and timeline previews share the theme's standard
  border; markdown images also pick up the rounded corner radius and extra
  block margin against the surrounding prose.

## [0.4.0](https://github.com/smsunarto/bb-plugins/compare/monokai/v0.3.2...monokai/v0.4.0) (2026-09-12)


### Features

* **bb-kit:** support core and plugin dev workflows ([3e2ac94](https://github.com/smsunarto/bb-plugins/commit/3e2ac94a0408d6256f3ccc1e97c3f87858c25299))
* **canvas:** mirror theme prose typography ([b6e3255](https://github.com/smsunarto/bb-plugins/commit/b6e325587df093e1738366952ce01c50c4d35b93))
* **monokai:** add UI font setting ([adfe18d](https://github.com/smsunarto/bb-plugins/commit/adfe18d8c2f9dc94228841613edceb111c290dd9))
* **monokai:** center all toast notifications above conversation ([21f3d15](https://github.com/smsunarto/bb-plugins/commit/21f3d1519f0e9bddb858d9031d9cadc332af2dac))
* **monokai:** supply canvas prose accent hues ([b6e3255](https://github.com/smsunarto/bb-plugins/commit/b6e325587df093e1738366952ce01c50c4d35b93))


### Bug Fixes

* **canvas,monokai:** stop Row links overlapping and quiet prose color ([b6e3255](https://github.com/smsunarto/bb-plugins/commit/b6e325587df093e1738366952ce01c50c4d35b93))
* **monokai:** align Monaco with Cursor colors ([7425a32](https://github.com/smsunarto/bb-plugins/commit/7425a32284a422430687655b07d3bcf545ed6f44))
* **monokai:** align new-thread composer with conversation footer ([12c7a15](https://github.com/smsunarto/bb-plugins/commit/12c7a1536f9a16b2e6ea79b4d6e3f92bc2fd2fd1))
* **monokai:** apply footer chip rules to every composer surface ([04a596e](https://github.com/smsunarto/bb-plugins/commit/04a596e539ad0d7de8777f7e23d8fc64f1d1e0f5))
* **monokai:** distinguish diff hunk separators ([0fc2a3b](https://github.com/smsunarto/bb-plugins/commit/0fc2a3b890d91ff1e9aebe0d0a1c84dbafc0806b))
* **monokai:** expand no-project machine label ([3795867](https://github.com/smsunarto/bb-plugins/commit/3795867cbca9418e7d66f1e6416edf26d1c64e81))
* **monokai:** frame inline images so they do not blend into the panel ([2f2e076](https://github.com/smsunarto/bb-plugins/commit/2f2e0769f6518b5b7641bb30d7abd73ac6dda9df))
* **monokai:** gate hover fills and tune phone typography ([303c518](https://github.com/smsunarto/bb-plugins/commit/303c518175f524dec664bfe8b0833f6ae946c67b))
* **monokai:** keep the page header on the pane ground ([f297d45](https://github.com/smsunarto/bb-plugins/commit/f297d45e9bec869e6daa51cbc6b95393e76c631e))
* **monokai:** match Ghostty terminal typography and background ([fa4065f](https://github.com/smsunarto/bb-plugins/commit/fa4065f3a7d4a4e07199ef006954fb698487b133))
* **monokai:** match mobile sidebar and status bar backgrounds ([4665c02](https://github.com/smsunarto/bb-plugins/commit/4665c02d400a5eea4fd2f59e729cbd706dd82562))
* **monokai:** open the new-thread slash menu above the composer ([c97165b](https://github.com/smsunarto/bb-plugins/commit/c97165b5075210f74b080e4bfdf94ef342e2a87c))
* **monokai:** paint model picker group headings on the popover ground ([6c366eb](https://github.com/smsunarto/bb-plugins/commit/6c366eb7705332e62638e592a6647d1a69bc9c2d))
* **monokai:** preserve native mobile selector layout ([fcfe0b1](https://github.com/smsunarto/bb-plugins/commit/fcfe0b1fb87eed5de541914ba78c14ed9a99ce2b))
* **monokai:** style built-in notifications ([117d094](https://github.com/smsunarto/bb-plugins/commit/117d09445580a9d737603b430609ccd431ead75b))
* **monokai:** tighten fenced code block leading so box-drawing rows connect ([c1e6789](https://github.com/smsunarto/bb-plugins/commit/c1e6789ab842c6976a9f57bdfc5ba44a0b73a47c))
* **monokai:** unify code backgrounds and file headers ([418fa56](https://github.com/smsunarto/bb-plugins/commit/418fa561013b38e04ff8621aea213dd8f7c41a47))
* **monokai:** unify sidebar dividers ([1521665](https://github.com/smsunarto/bb-plugins/commit/15216657f4e303040b4e5cbbdbbe29023b02b312))
* **monokai:** use recessed background for sidebar diffs ([7df139a](https://github.com/smsunarto/bb-plugins/commit/7df139a10931ee503625643154aaf03449881a58))
* **monokai:** use the shared sidebar background for secondary panels ([fa52116](https://github.com/smsunarto/bb-plugins/commit/fa52116a21bc78a903429fa66d389d4bd943df60))
* **plugins:** support bb 0.41 ([f2418f4](https://github.com/smsunarto/bb-plugins/commit/f2418f4c42786a7f5c8fce13e6d075a38b8eab71))
* **tooling:** clear repository quality gates ([4155137](https://github.com/smsunarto/bb-plugins/commit/41551375c36ac22a83daef851e065a8cf9c33151))

## 0.3.2

### Patch Changes

- 3da36f5: Support bb 0.40. The engines floor moves to the tested bb release (`>=0.40.0 <1.0.0`) and the plugin is built against plugin SDK 0.4.21.

## 0.3.1

### Patch Changes

- 1432728: Support bb 0.39. The engines range is no longer pinned to one minor: it now floors at the tested bb release and excludes only the next major (`>=0.39.0 <1.0.0`), so future bb minors load without a plugin update. Built against plugin SDK 0.4.8.

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
