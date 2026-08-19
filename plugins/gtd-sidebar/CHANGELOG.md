# @smsunarto/bb-plugin-gtd-sidebar

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
