# @smsunarto/bb-plugin-gtd-sidebar

## [0.5.0](https://github.com/smsunarto/bb-plugins/compare/gtd-sidebar/v0.4.2...gtd-sidebar/v0.5.0) (2026-09-05)


### Features

* **bb-kit:** support core and plugin dev workflows ([3e2ac94](https://github.com/smsunarto/bb-plugins/commit/3e2ac94a0408d6256f3ccc1e97c3f87858c25299))
* **gtd-sidebar:** add thread naming ([2b79e63](https://github.com/smsunarto/bb-plugins/commit/2b79e6335b8ff3e73867bff51e7a629cd056c736))
* **gtd-sidebar:** compact mobile thread cards ([6f632d9](https://github.com/smsunarto/bb-plugins/commit/6f632d97970626ff55dce53959f261b824d44294))
* **gtd-sidebar:** iOS long-press frosted menu on mobile ([08559f4](https://github.com/smsunarto/bb-plugins/commit/08559f4f91a2d3ca7041a58f4f64169e40b69424))
* **gtd-sidebar:** refresh titles after user turns ([a010c7a](https://github.com/smsunarto/bb-plugins/commit/a010c7abd71b744951e67db905e6a353aaeb765d))
* **gtd-sidebar:** reorder compact menu actions and drop archive ([6883c93](https://github.com/smsunarto/bb-plugins/commit/6883c93ea2ce81b4281c2305cb207a58d62748d5))
* **gtd-sidebar:** sort every section by recent activity ([fe8556a](https://github.com/smsunarto/bb-plugins/commit/fe8556acee521fa8c4edd1b0964b8efa0b012f11))
* **gtd-sidebar:** support project title instructions ([9da1aa8](https://github.com/smsunarto/bb-plugins/commit/9da1aa888849fe28e3a497b696da891dea941945))
* **gtd:** improve GTD Sidebar mobile usability ([#110](https://github.com/smsunarto/bb-plugins/issues/110)) ([b288159](https://github.com/smsunarto/bb-plugins/commit/b288159709a3eb258f53916aaab8edc83f230c6c))


### Bug Fixes

* **gtd-sidebar:** align desktop menu with mobile ([171806d](https://github.com/smsunarto/bb-plugins/commit/171806d62174b2b2d2e731ce038d031453c0ebd4))
* **gtd-sidebar:** align menu and highlight with shared layer styling ([d4ad410](https://github.com/smsunarto/bb-plugins/commit/d4ad4100a62773d5a8c8667ef78e98f0264795a1))
* **gtd-sidebar:** ask for sentence-case thread titles ([97878eb](https://github.com/smsunarto/bb-plugins/commit/97878eb2b43cadd99e8b699c93b466a0a7a72040))
* **gtd-sidebar:** focus next thread after settle ([18d6c74](https://github.com/smsunarto/bb-plugins/commit/18d6c74d46415babc341e079fa22950167a6c08d))
* **gtd-sidebar:** keep settles authoritative ([244c4a7](https://github.com/smsunarto/bb-plugins/commit/244c4a72c4cf3251bb4c5fe713ef30eb206b2dec))
* **gtd-sidebar:** open settled threads ([7350ed3](https://github.com/smsunarto/bb-plugins/commit/7350ed34f8c68f9b5c515c4903209773ac8597a8))
* **gtd-sidebar:** show newest waiting entries first ([1f30711](https://github.com/smsunarto/bb-plugins/commit/1f30711f4ed2eec3ddf0af98ce14c87816e3d394))
* **gtd-sidebar:** sort each section by the clock it can answer for ([70168ae](https://github.com/smsunarto/bb-plugins/commit/70168aef75565db89890257f5b9fb8c423835661))
* **gtd-sidebar:** support bb 0.41 ([2c97e1a](https://github.com/smsunarto/bb-plugins/commit/2c97e1ac7d3d52a03d399dc9e0404841ab13e3fe))
* **gtd-sidebar:** use Luna for thread naming ([1259aca](https://github.com/smsunarto/bb-plugins/commit/1259acaa32d2bce1815daccbcfbdb7571cefb407))
* **tooling:** clear repository quality gates ([4155137](https://github.com/smsunarto/bb-plugins/commit/41551375c36ac22a83daef851e065a8cf9c33151))

## 0.4.2

### Patch Changes

- 3da36f5: Support bb 0.40. The engines floor moves to the tested bb release (`>=0.40.0 <1.0.0`) and the plugin is built against plugin SDK 0.4.21.
- 14254e6: Show the applied GitButler virtual branch instead of `gitbutler/workspace` on thread cards. When several virtual branches are applied, show their count rather than guessing one.

## 0.4.1

### Patch Changes

- 1432728: Support bb 0.39. The engines range is no longer pinned to one minor: it now floors at the tested bb release and excludes only the next major (`>=0.39.0 <1.0.0`), so future bb minors load without a plugin update. Built against plugin SDK 0.4.8.

## 0.4.0

### Minor Changes

- 1e0165e: Rename the plugin from t3sidebar to GTD Sidebar, id `gtd-sidebar`.

  bb keys a plugin by the id it derives from the package name, so this installs as
  a separate plugin rather than an update: install `gtd-sidebar`, then uninstall
  `t3sidebar`. Settled and snoozed shelves live in the old plugin's database and
  do not carry over. Releases are now tagged `gtd-sidebar/vX.Y.Z`.

  The warm-start cache moves to `gtd-sidebar:v1:*` in `localStorage`, and the
  first successful write removes the `t3sidebar:v1:*` entries — bb's uninstall
  does not clear web storage, and after the rename nothing else ever would.

## 0.3.0

### Minor Changes

- 1896f82: Compact the inbox. The thread card drops to two lines — title and status, then
  project, branch, activity, PR and agent — for 52px instead of ~75px. Slim rows,
  shelf headers and the project scope picker each lose a few pixels with them.
  The meta line sits one full step below the title in both size and tint, and
  cards keep a real gap rather than a hairline.

  Add a **Show the agent icon on each card** setting, on by default. Turning it off
  drops the trailing agent glyph and gives the branch that space back.

  Keep the project scope picker's track clear. It dropped its border width but kept
  `border-input`, so a theme that keys a field background off that class painted a
  filled well behind a control meant to read as a label.

### Patch Changes

- 186c131: Make the release tag installable. Every import the server bundle pulls in at
  runtime is now a real `dependencies` entry, so `bb plugin install` from a git
  tag resolves it. The previous tags built only inside this workspace, where a
  hoisted `node_modules` supplied what the manifests had left out as devDependencies —
  a fresh checkout of the tag failed the build with `Could not resolve "zod"`.

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
