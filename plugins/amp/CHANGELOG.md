# @smsunarto/bb-plugin-amp

## 0.4.2

### Patch Changes

- 3da36f5: Support bb 0.40. The engines floor moves to the tested bb release (`>=0.40.0 <1.0.0`) and the plugin is built against plugin SDK 0.4.21.

## 0.4.1

### Patch Changes

- 1432728: Support bb 0.39. The engines range is no longer pinned to one minor: it now floors at the tested bb release and excludes only the next major (`>=0.39.0 <1.0.0`), so future bb minors load without a plugin update. Built against plugin SDK 0.4.8.

## 0.4.0

### Minor Changes

- 2c4cef6: Give the Amp thread back when bb unarchives. Archiving a bb thread archived its
  Amp thread, and nothing reversed it.

  The restore cannot be received: bb 0.38 emits six plugin thread events —
  `created`, `active`, `idle`, `failed`, `archived`, `deleted` — and unarchive is
  not one. So the archive half stays event-driven and the restore half is polled.
  `thread.archived` writes an `amp-archive-watch:<id>` row naming the Amp thread
  it took, and a background service asks bb every 20 seconds which of those bb
  still calls archived. Reading the state covers t3sidebar and bb's own view at
  once, rather than the action either one performs.

  The listing is one paginated query however many rows are watched, and the pass
  exits before it when there are none. It only suggests a restore — it is capped
  and drops deleted threads — so each candidate is confirmed against the thread
  itself first. Amp has no `threads unarchive`; the restore is `threads archive
<id> --unarchive`, one flag from the archive path. A candidate that fails three
  times, an Amp thread deleted on Amp's side being that case, is dropped rather
  than retried forever.

  Threads archived before this upgrade carry no watch row and are not restored.

### Patch Changes

- 186c131: Make the release tag installable. Every import the server bundle pulls in at
  runtime is now a real `dependencies` entry, so `bb plugin install` from a git
  tag resolves it. The previous tags built only inside this workspace, where a
  hoisted `node_modules` supplied what the manifests had left out as devDependencies —
  a fresh checkout of the tag failed the build with `Could not resolve "zod"`.
- 186c131: Ship the ACP bridge in the tag. bb runs no lifecycle script for a git install,
  so the sidecar it never compiles — `dist/bridge.js` and the CLI shim — has to be
  committed rather than built on the consumer's machine. CI diffs both against a
  fresh build so they cannot go stale.

  Align `zod` with the plugin SDK's peer range, which the bridge shares.

## 0.3.0

### Minor Changes

- b3ed493: Require bb 0.38 and take the SDK types from the published `@get-bb/plugin-sdk`
  package. `engines.bb` is now `>=0.38.0 <0.39.0`, so an older bb no longer
  installs these plugins.

  Agent Proxy gains a `routingStrategy` setting (`round-robin`, `fill-first`, or
  `weighted-round-robin`) that it writes to the core `config.yaml`. Pick
  `fill-first` to keep several Claude OAuth accounts from rotating away the
  upstream prompt cache.

- 65ececd: Release the runtime, presentation, notification, theme, and thread workflow updates.
