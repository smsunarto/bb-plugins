# @smsunarto/bb-plugin-agentation

## Unreleased

### Patch Changes

- Expose the staged-annotation composer banner as a stable theme surface.
- Declare the CLI with the SDK's `defineCli`; `--help` works on every command and user errors carry a hint. Requires plugin SDK 0.4.104.
- Mark the RPC contract discoverable with per-method descriptions (`bb plugin rpc inspect agentation`).
- Remove annotation mentions from the composer when their annotations are sent or discarded, and refresh the banner after the draft is submitted.
- Map the app-overlay, browser-toolbar-action, and timeline-renderer plugin surfaces for annotations.
- Map bb 0.44's sidebar header and sidebar navigation slots, plus the diff, source-code, sidebar-footer, and provider-input slots, to their public SDK registrations.
- Name the sidebar row an annotation on bb's Navigation plugin points at, and the `navPanel` entry behind it.
- Record whether an annotated plugin ships with bb (bundled thread list, Navigation) or was installed, and where from.
- Keep turn assignments across a restart or plugin safe mode while their thread is still mid-turn, instead of re-staging them.

## [0.4.0](https://github.com/smsunarto/bb-plugins/compare/agentation/v0.3.0...agentation/v0.4.0) (2026-09-26)


### Features

* **agentation:** attribute bb 0.44 sidebar surfaces to their owner plugin ([da925e2](https://github.com/smsunarto/bb-plugins/commit/da925e23c98c4e3cdd086ee954b36904b3a9cf9e))
* **agentation:** make the RPC contract discoverable ([7fcbbaf](https://github.com/smsunarto/bb-plugins/commit/7fcbbaf0a81f5b215d25c58c985a40cf1b226cfb))
* **agentation:** map overlay, browser toolbar, and timeline surfaces ([708bed4](https://github.com/smsunarto/bb-plugins/commit/708bed4bc6e9dcf9a8a5169327dc08f5ab83e749))


### Bug Fixes

* **agentation:** keep turn assignments while their thread is mid-turn ([beb1d37](https://github.com/smsunarto/bb-plugins/commit/beb1d3727dfdcaa25dca805fe1070698b8159479))

## [0.3.0](https://github.com/smsunarto/bb-plugins/compare/agentation/v0.2.3...agentation/v0.3.0) (2026-09-15)

### Features

- **bb-kit:** support core and plugin dev workflows ([3e2ac94](https://github.com/smsunarto/bb-plugins/commit/3e2ac94a0408d6256f3ccc1e97c3f87858c25299))

### Bug Fixes

- **agentation:** hide inactive toolbar controls ([b87bfa8](https://github.com/smsunarto/bb-plugins/commit/b87bfa89104ada30ce97d856cb1b9937f60acb38))
- **ci:** repair icon, skill, lint, and packaging checks ([6c13374](https://github.com/smsunarto/bb-plugins/commit/6c133744736b2fd6bf4c55bce7e3cc2f9adecf40))
- **plugins:** support bb 0.41 ([f2418f4](https://github.com/smsunarto/bb-plugins/commit/f2418f4c42786a7f5c8fce13e6d075a38b8eab71))
- **tooling:** clear repository quality gates ([4155137](https://github.com/smsunarto/bb-plugins/commit/41551375c36ac22a83daef851e065a8cf9c33151))

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
