# @smsunarto/bb-plugin-agent-proxy

## [0.3.0](https://github.com/smsunarto/bb-plugins/compare/agent-proxy/v0.2.4...agent-proxy/v0.3.0) (2026-09-05)


### Features

* **agent-proxy:** add Cloudflare tunnel support for Agent Proxy Cursor BYOK ([#108](https://github.com/smsunarto/bb-plugins/issues/108)) ([c5d1347](https://github.com/smsunarto/bb-plugins/commit/c5d1347b96b7456c905566825a13ae97284801bb))
* **bb-kit:** support core and plugin dev workflows ([3e2ac94](https://github.com/smsunarto/bb-plugins/commit/3e2ac94a0408d6256f3ccc1e97c3f87858c25299))


### Bug Fixes

* **agent-proxy:** isolate dev service and port ([e5c1e40](https://github.com/smsunarto/bb-plugins/commit/e5c1e4022cdd49578eea1d11960af16e0276597f))
* **plugins:** support bb 0.41 ([f2418f4](https://github.com/smsunarto/bb-plugins/commit/f2418f4c42786a7f5c8fce13e6d075a38b8eab71))

## 0.2.4

### Patch Changes

- 3da36f5: Support bb 0.40. The engines floor moves to the tested bb release (`>=0.40.0 <1.0.0`) and the plugin is built against plugin SDK 0.4.21.

## 0.2.3

### Patch Changes

- ca25205: Emit `WorkingDirectory=`, `StandardOutput=`, and `StandardError=` unquoted in the generated systemd user unit. systemd rejects a quoted `WorkingDirectory=` as a fatal unit error, so the core service never loaded on Linux, and quoted output directives silently sent core logs to the journal instead of `core.log`.

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
