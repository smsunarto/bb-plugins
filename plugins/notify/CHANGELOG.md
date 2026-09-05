# @smsunarto/bb-plugin-notify

## [0.4.0](https://github.com/smsunarto/bb-plugins/compare/notify/v0.3.0...notify/v0.4.0) (2026-09-05)


### Features

* **bb-kit:** enable plugin telemetry by default with settings opt-out ([abd398b](https://github.com/smsunarto/bb-plugins/commit/abd398b361a19044b486bfec212bb9020f6dbaba))
* **bb-kit:** support core and plugin dev workflows ([3e2ac94](https://github.com/smsunarto/bb-plugins/commit/3e2ac94a0408d6256f3ccc1e97c3f87858c25299))
* **notify:** add Cursor completion sound ([6902e8a](https://github.com/smsunarto/bb-plugins/commit/6902e8acd6b61720c7c33ad5cdccad954777fc57))
* **plugins:** wire Sentry telemetry into gitbutler, nanocodex, notify ([fbc94a8](https://github.com/smsunarto/bb-plugins/commit/fbc94a8f99b37e6f4f0c8748506a5e700bc880fc))
* **sentry:** report plugin failures across runtimes ([3cb8b76](https://github.com/smsunarto/bb-plugins/commit/3cb8b76c64e171e85e640a89c8156db4690f38c1))
* **sentry:** split plugin telemetry projects ([e6ffff9](https://github.com/smsunarto/bb-plugins/commit/e6ffff9495c140bb8334af1ab916405c5ffc492f))


### Bug Fixes

* **notify:** keep the renderer poller alive past bb's content-script mount timeout ([7c81342](https://github.com/smsunarto/bb-plugins/commit/7c81342cb9a35347f851f254646e61865323e671))
* **plugins:** support bb 0.41 ([f2418f4](https://github.com/smsunarto/bb-plugins/commit/f2418f4c42786a7f5c8fce13e6d075a38b8eab71))

## 0.3.0

### Minor Changes

- 902ca5d: Post notifications through an open BB desktop renderer so macOS uses BB's
  identity and icon. Clicking an alert opens its thread. Alerts are discarded
  instead of stored when no desktop window is available.

### Patch Changes

- 3da36f5: Support bb 0.40. The engines floor moves to the tested bb release (`>=0.40.0 <1.0.0`) and the plugin is built against plugin SDK 0.4.21. Tool status labels move from the experimental field to the stable presentation API.

## 0.2.2

### Patch Changes

- 1432728: Support bb 0.39. The engines range is no longer pinned to one minor: it now floors at the tested bb release and excludes only the next major (`>=0.39.0 <1.0.0`), so future bb minors load without a plugin update. Built against plugin SDK 0.4.8.

## 0.2.1

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

### Patch Changes

- 65ececd: Release the runtime, presentation, notification, theme, and thread workflow updates.
