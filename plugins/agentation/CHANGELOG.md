# @smsunarto/bb-plugin-agentation

## 0.2.3

### Patch Changes

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
