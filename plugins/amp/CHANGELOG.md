# @smsunarto/bb-plugin-amp

## [0.5.0](https://github.com/smsunarto/bb-plugins/compare/amp/v0.4.1...amp/v0.5.0) (2026-09-05)


### Features

* **amp:** add startup performance tracing ([9df50eb](https://github.com/smsunarto/bb-plugins/commit/9df50ebc5e73b0f8a6fada09dad09a5b922e44ba))
* **bb-kit:** support core and plugin dev workflows ([3e2ac94](https://github.com/smsunarto/bb-plugins/commit/3e2ac94a0408d6256f3ccc1e97c3f87858c25299))
* **sentry:** harden plugin telemetry ([5408358](https://github.com/smsunarto/bb-plugins/commit/5408358a95cf60d207e0a0bc69dfef431bfd7dd8))
* **sentry:** report plugin failures across runtimes ([3cb8b76](https://github.com/smsunarto/bb-plugins/commit/3cb8b76c64e171e85e640a89c8156db4690f38c1))
* **sentry:** split plugin telemetry projects ([e6ffff9](https://github.com/smsunarto/bb-plugins/commit/e6ffff9495c140bb8334af1ab916405c5ffc492f))


### Bug Fixes

* **amp:** document bb 0.40 release line ([fb887e3](https://github.com/smsunarto/bb-plugins/commit/fb887e36cbeeccef7aac0409bb7075bc159697af))
* **amp:** recover from websocket disconnects ([#109](https://github.com/smsunarto/bb-plugins/issues/109)) ([0e4498d](https://github.com/smsunarto/bb-plugins/commit/0e4498d83342c3dcec0d28d03fe1a27377d8e64a))
* **plugins:** ship provider sdk at runtime ([52b8dc5](https://github.com/smsunarto/bb-plugins/commit/52b8dc513e731f223c17d3f9c4f4bcb7b07771f0))
* **plugins:** support bb 0.41 ([f2418f4](https://github.com/smsunarto/bb-plugins/commit/f2418f4c42786a7f5c8fce13e6d075a38b8eab71))
* **tooling:** clear repository quality gates ([4155137](https://github.com/smsunarto/bb-plugins/commit/41551375c36ac22a83daef851e065a8cf9c33151))

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
