# @smsunarto/bb-plugin-agentation

## [0.3.0](https://github.com/smsunarto/bb-plugins/compare/agentation/v0.2.3...agentation/v0.3.0) (2026-09-05)


### Features

* **bb-kit:** support core and plugin dev workflows ([3e2ac94](https://github.com/smsunarto/bb-plugins/commit/3e2ac94a0408d6256f3ccc1e97c3f87858c25299))


### Bug Fixes

* **agentation:** hide inactive toolbar controls ([b87bfa8](https://github.com/smsunarto/bb-plugins/commit/b87bfa89104ada30ce97d856cb1b9937f60acb38))
* **plugins:** support bb 0.41 ([f2418f4](https://github.com/smsunarto/bb-plugins/commit/f2418f4c42786a7f5c8fce13e6d075a38b8eab71))
* **tooling:** clear repository quality gates ([4155137](https://github.com/smsunarto/bb-plugins/commit/41551375c36ac22a83daef851e065a8cf9c33151))

## 0.2.3

### Patch Changes

- 3da36f5: Support bb 0.40. The engines floor moves to the tested bb release (`>=0.40.0 <1.0.0`) and the plugin is built against plugin SDK 0.4.21. Tool status labels move from the experimental field to the stable presentation API.
- 5f445aa: Enrich annotations with the exact public bb plugin UI surface and registration id that own the selected element, including component slots, composer contributions, and host-rendered plugin actions. Render source-oriented prompt guidance that points agents to the matching SDK registration in the plugin frontend. Keep the global React toolbar compatible with bb's foreign-DOM mutation guard.

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
- 186c131: Vendor the patched upstream instead of relying on a Bun patch. `patchedDependencies`
  is a workspace-install feature; a consumer installing the tag got the unpatched
  package. The modified copy now lives at `vendor/agentation` with its changes
  recorded in `vendor/agentation.patch` and its PolyForm Shield licence beside it.

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
