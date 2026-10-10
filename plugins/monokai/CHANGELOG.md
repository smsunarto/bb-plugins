# @smsunarto/bb-plugin-monokai

## [0.5.0](https://github.com/smsunarto/bb-plugins/compare/monokai/v0.4.0...monokai/v0.5.0) (2026-10-10)


### Features

* **canvas,docs,monokai:** style prose with the shared markdown-prose sheet ([376b547](https://github.com/smsunarto/bb-plugins/commit/376b547af50eef2255ae0eea4fc330df7e3cfee5))
* **docs,monokai:** theme Docs prose through --docs-prose-* hooks ([debdfaa](https://github.com/smsunarto/bb-plugins/commit/debdfaa9f92cf66d085bca16f0136341e182e341))
* **monokai:** antialias dark text and balance markdown wrapping ([6e278e1](https://github.com/smsunarto/bb-plugins/commit/6e278e11476ddaf2a23fcd1bcbb194ea693c92b8))
* **monokai:** let a plugin opt into the diff-header treatment ([2ddd66c](https://github.com/smsunarto/bb-plugins/commit/2ddd66cbc1daf0b5e5de881f46327ba8a0c2a5bc))
* **monokai:** match the Codex app's agent stream geometry ([470da01](https://github.com/smsunarto/bb-plugins/commit/470da01165f1813f7aa7deeef6d4b113306f734b))
* **monokai:** set agent message prose to 14px ([d2cf19e](https://github.com/smsunarto/bb-plugins/commit/d2cf19e422d545bcb482f491854f2373b8c6c4b7))
* **monokai:** tint inline code a soft yellow ([a4ea949](https://github.com/smsunarto/bb-plugins/commit/a4ea949b770c0669a6208777b409466ec6c266d5))


### Bug Fixes

* **monokai:** cover the tucked queue card and align queued text ([43555f2](https://github.com/smsunarto/bb-plugins/commit/43555f2d76281b872454dad8fa70c601b67391ec))
* **monokai:** keep message actions clear of the Last turn diff card ([b5eb5f5](https://github.com/smsunarto/bb-plugins/commit/b5eb5f5c6602ff27d634371864154fd0ed29a2d4))
* **monokai:** mute marketplace category icons ([bc41dc0](https://github.com/smsunarto/bb-plugins/commit/bc41dc0c1ea44727ce00bb55de38d90b9851254d))
* **monokai:** polish bb 0.45 surfaces, adapters, and checks ([65bd237](https://github.com/smsunarto/bb-plugins/commit/65bd237e023b389238afc4428016ee22967c3f33))
* **monokai:** replace Codex glyphs with Lucide icons ([66a3a14](https://github.com/smsunarto/bb-plugins/commit/66a3a144d8c75d039e97c878c4badc9f9d9fa97d))
* **monokai:** restore safe-area padding in mobile picker drawers ([b60bd93](https://github.com/smsunarto/bb-plugins/commit/b60bd939f54b6aa1a6977ec8e9771c82558f7df4))


### Performance Improvements

* **monokai:** drop the composer and settings :has() rules ([5ec0192](https://github.com/smsunarto/bb-plugins/commit/5ec01926de2ea750501f1725aaaf03221c4d3ad8))
* **monokai:** drop the remaining :has() rules ([77b1b9f](https://github.com/smsunarto/bb-plugins/commit/77b1b9f70091072037976037754048e15bc88a28))
* **monokai:** stop right-panel resize from restyling the whole panel ([3a489a9](https://github.com/smsunarto/bb-plugins/commit/3a489a92c8637f784b91e1b8472ec6019ce50696))
* **monokai:** tag diff cards, shells, and panels instead of matching them with :has() ([f3309bc](https://github.com/smsunarto/bb-plugins/commit/f3309bc14d73237920c4d0117c3212e4ff170f45))
* **monokai:** tag diff headers instead of matching them with :has() ([cee99ce](https://github.com/smsunarto/bb-plugins/commit/cee99ce7ef341e5f5a64f481e550afea69b492da))

## [0.4.0](https://github.com/smsunarto/bb-plugins/compare/monokai/v0.3.2...monokai/v0.4.0) (2026-09-15)

### Features

- **bb-kit:** support core and plugin dev workflows ([3e2ac94](https://github.com/smsunarto/bb-plugins/commit/3e2ac94a0408d6256f3ccc1e97c3f87858c25299))
- **canvas:** mirror theme prose typography ([b6e3255](https://github.com/smsunarto/bb-plugins/commit/b6e325587df093e1738366952ce01c50c4d35b93))
- **monokai:** add UI font setting ([adfe18d](https://github.com/smsunarto/bb-plugins/commit/adfe18d8c2f9dc94228841613edceb111c290dd9))
- **monokai:** apply alpha surfaces throughout the theme ([e7f771d](https://github.com/smsunarto/bb-plugins/commit/e7f771d7fbce2f5bec6c00215175485888ebdc29))
- **monokai:** center all toast notifications above conversation ([21f3d15](https://github.com/smsunarto/bb-plugins/commit/21f3d1519f0e9bddb858d9031d9cadc332af2dac))
- **monokai:** compose controls with shared alpha layers ([e9fc3a3](https://github.com/smsunarto/bb-plugins/commit/e9fc3a3725a75fb3ea0bd099a477db2b318f0b37))
- **monokai:** supply canvas prose accent hues ([b6e3255](https://github.com/smsunarto/bb-plugins/commit/b6e325587df093e1738366952ce01c50c4d35b93))

### Bug Fixes

- **canvas,monokai:** stop Row links overlapping and quiet prose color ([b6e3255](https://github.com/smsunarto/bb-plugins/commit/b6e325587df093e1738366952ce01c50c4d35b93))
- **monokai:** add diff status icons and hide editor buttons ([403ceab](https://github.com/smsunarto/bb-plugins/commit/403ceab339fa5b5de35081b4ebdf928d5f824803))
- **monokai:** align Monaco with Cursor colors ([7425a32](https://github.com/smsunarto/bb-plugins/commit/7425a32284a422430687655b07d3bcf545ed6f44))
- **monokai:** align new-thread composer with conversation footer ([12c7a15](https://github.com/smsunarto/bb-plugins/commit/12c7a1536f9a16b2e6ea79b4d6e3f92bc2fd2fd1))
- **monokai:** apply footer chip rules to every composer surface ([04a596e](https://github.com/smsunarto/bb-plugins/commit/04a596e539ad0d7de8777f7e23d8fc64f1d1e0f5))
- **monokai:** contain composer background within border ([2446be9](https://github.com/smsunarto/bb-plugins/commit/2446be9a417f59df6580d54eafe67900e49fe26f))
- **monokai:** cover settings containers and annotated surfaces ([d1c43a8](https://github.com/smsunarto/bb-plugins/commit/d1c43a872a9c1f15683a4502b3cec75e69b3df63))
- **monokai:** distinguish diff hunk separators ([0fc2a3b](https://github.com/smsunarto/bb-plugins/commit/0fc2a3b890d91ff1e9aebe0d0a1c84dbafc0806b))
- **monokai:** expand no-project machine label ([3795867](https://github.com/smsunarto/bb-plugins/commit/3795867cbca9418e7d66f1e6416edf26d1c64e81))
- **monokai:** frame inline images so they do not blend into the panel ([2f2e076](https://github.com/smsunarto/bb-plugins/commit/2f2e0769f6518b5b7641bb30d7abd73ac6dda9df))
- **monokai:** gate hover fills and tune phone typography ([303c518](https://github.com/smsunarto/bb-plugins/commit/303c518175f524dec664bfe8b0833f6ae946c67b))
- **monokai:** harden runtime adapters ([c490cb2](https://github.com/smsunarto/bb-plugins/commit/c490cb2dbe2d138df542f8750995ff32011811cc))
- **monokai:** keep notification text and actions from overlapping ([c069a44](https://github.com/smsunarto/bb-plugins/commit/c069a44bbeecffd16acf25ddd09ce5f13521f4ae))
- **monokai:** keep the page header on the pane ground ([f297d45](https://github.com/smsunarto/bb-plugins/commit/f297d45e9bec869e6daa51cbc6b95393e76c631e))
- **monokai:** lift collapsed timeline toggles to the readback step ([814b95c](https://github.com/smsunarto/bb-plugins/commit/814b95c7d8a6a706580bd50fc7f0e294aa7d38cd))
- **monokai:** match Ghostty terminal typography and background ([fa4065f](https://github.com/smsunarto/bb-plugins/commit/fa4065f3a7d4a4e07199ef006954fb698487b133))
- **monokai:** match mobile sidebar and status bar backgrounds ([4665c02](https://github.com/smsunarto/bb-plugins/commit/4665c02d400a5eea4fd2f59e729cbd706dd82562))
- **monokai:** open the new-thread slash menu above the composer ([c97165b](https://github.com/smsunarto/bb-plugins/commit/c97165b5075210f74b080e4bfdf94ef342e2a87c))
- **monokai:** paint model picker group headings on the popover ground ([6c366eb](https://github.com/smsunarto/bb-plugins/commit/6c366eb7705332e62638e592a6647d1a69bc9c2d))
- **monokai:** preserve native mobile selector layout ([fcfe0b1](https://github.com/smsunarto/bb-plugins/commit/fcfe0b1fb87eed5de541914ba78c14ed9a99ce2b))
- **monokai:** shade the last turn heading ([06b6834](https://github.com/smsunarto/bb-plugins/commit/06b6834d59ca160772e5de38a71d2dd4d2aa5ab9))
- **monokai:** style built-in notifications ([117d094](https://github.com/smsunarto/bb-plugins/commit/117d09445580a9d737603b430609ccd431ead75b))
- **monokai:** tighten fenced code block leading so box-drawing rows connect ([c1e6789](https://github.com/smsunarto/bb-plugins/commit/c1e6789ab842c6976a9f57bdfc5ba44a0b73a47c))
- **monokai:** unify code backgrounds and file headers ([418fa56](https://github.com/smsunarto/bb-plugins/commit/418fa561013b38e04ff8621aea213dd8f7c41a47))
- **monokai:** unify sidebar dividers ([1521665](https://github.com/smsunarto/bb-plugins/commit/15216657f4e303040b4e5cbbdbbe29023b02b312))
- **monokai:** use recessed background for sidebar diffs ([7df139a](https://github.com/smsunarto/bb-plugins/commit/7df139a10931ee503625643154aaf03449881a58))
- **monokai:** use the shared sidebar background for secondary panels ([fa52116](https://github.com/smsunarto/bb-plugins/commit/fa52116a21bc78a903429fa66d389d4bd943df60))
- **plugins:** support bb 0.41 ([f2418f4](https://github.com/smsunarto/bb-plugins/commit/f2418f4c42786a7f5c8fce13e6d075a38b8eab71))
- **tooling:** clear repository quality gates ([4155137](https://github.com/smsunarto/bb-plugins/commit/41551375c36ac22a83daef851e065a8cf9c33151))

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
