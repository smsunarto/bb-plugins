# @smsunarto/bb-plugin-agentation

## Unreleased

### Patch Changes

- Update the vendored Agentation toolbar from 3.0.2 to 3.1.2: selection inside same-origin iframes and open shadow roots, keyboard and focus fixes, and Copy/Send keep feedback that changed or failed mid-operation. The toolbar now renders in a shadow root, so its styles no longer leak into bb and the `fill-current` icon workaround is gone. Upstream now ships the `inert` fixes this plugin patched in; the patch keeps only React 19 component detection.
- Expose the staged-annotation composer banner as a stable theme surface.
- Declare the CLI with the SDK's `defineCli`; `--help` works on every command and user errors carry a hint. Requires plugin SDK 0.4.104.
- Mark the RPC contract discoverable with per-method descriptions (`bb plugin rpc inspect agentation`).
- Remove annotation mentions from the composer when their annotations are sent or discarded, and refresh the banner after the draft is submitted.
- Map the app-overlay, browser-toolbar-action, and timeline-renderer plugin surfaces for annotations.
- Map bb 0.44's sidebar header and sidebar navigation slots, plus the diff, source-code, sidebar-footer, and provider-input slots, to their public SDK registrations.
- Name the sidebar row an annotation on bb's Navigation plugin points at, and the `navPanel` entry behind it.
- Record whether an annotated plugin ships with bb (bundled thread list, Navigation) or was installed, and where from.
- Show staged annotations in the new-thread composer. Pills mentioned there are assigned to the thread their first message creates and re-stage when its turn ends unresolved.
- Show the staged batch as a compact `N annotations` composer pill, modeled on the Codex app. Hover or click it for a numbered list with each annotation's element, location, and full comment, plus mention, send, and discard actions.
- Keep turn assignments across a restart or plugin safe mode while their thread is still mid-turn, instead of re-staging them.
- Reopen the toolbar's event stream when it closes for good (a plugin reload, a server restart, the tunnel's offline page) or goes silent past two heartbeats, instead of polling every 4 seconds until the page reloads. The healthy safety-net poll drops from 30 seconds to 5 minutes, toolbars skip pulls for other pages' changes, and an unchanged pull no longer carries the annotation list.
- The review panel, its header, and every staged-annotation banner share one request per change and skip changes that cannot affect them. Panel actions show their result at once instead of waiting for a refetch.

## [0.4.0](https://github.com/smsunarto/bb-plugins/compare/agentation/v0.3.0...agentation/v0.4.0) (2026-10-31)


### Features

* **agentation,t3-composer:** show staged annotations as a chip beside attachments ([c7dc505](https://github.com/smsunarto/bb-plugins/commit/c7dc505865c2b7ebd90815fa06fdae4c0a9f8b57))
* **agentation:** add configurable feedback mode shortcut ([0d7af64](https://github.com/smsunarto/bb-plugins/commit/0d7af648e476014311f4e9e76d158f72fa220886))
* **agentation:** launch feedback from the footer and send new-thread batches ([673173c](https://github.com/smsunarto/bb-plugins/commit/673173ce2f95666538b1909316a09d8600b32620))
* **agentation:** move toolbar toggle to sidebar footer ([cfaf107](https://github.com/smsunarto/bb-plugins/commit/cfaf107d35d644ffba86f5ab1d9578eaae68dd5a))
* **agentation:** open feedback with Escape then A ([baf92ae](https://github.com/smsunarto/bb-plugins/commit/baf92aee4ae09beddfe7e8818555534cf616e329))
* **agentation:** show staged annotations as a Codex-style composer pill ([ae93eb7](https://github.com/smsunarto/bb-plugins/commit/ae93eb7ed637c5b451ce02909c67260edd66d849))
* **agentation:** show staged annotations as a composer action button ([9a60c92](https://github.com/smsunarto/bb-plugins/commit/9a60c9275838d8a0fba8fe9611b2abbd9d694d76))
* **agentation:** show staged annotations in the new-thread composer ([78d255b](https://github.com/smsunarto/bb-plugins/commit/78d255b72bd15b7c8c2c3af56ca25cb547465312))
* **branding:** give every plugin a distinct BB-style icon ([e6a07fe](https://github.com/smsunarto/bb-plugins/commit/e6a07fe24cfd954203fc3007c3e9817de4b9376e))
* **plugins:** adopt BB 0.48 SDK APIs ([7fcbe74](https://github.com/smsunarto/bb-plugins/commit/7fcbe74366553e460c2992080af34533c7642649))
* **plugins:** replace plugin icons with Lucide via better-icons ([765f389](https://github.com/smsunarto/bb-plugins/commit/765f38988bcf8107889ec51890377f85c00dcdf3))
* **storybook:** catalog custom components across browser plugins ([1345a92](https://github.com/smsunarto/bb-plugins/commit/1345a926b6b281ae7ab0c6d7fcc6f1807130d77b))
* **storybook:** populate realistic review and workflow scenarios ([b58f4e7](https://github.com/smsunarto/bb-plugins/commit/b58f4e7b9865f3997da18c886de76aac7652db20))


### Bug Fixes

* **agentation:** record the assigned thread only once delivery is confirmed ([882c261](https://github.com/smsunarto/bb-plugins/commit/882c261299a05a99c749e65d2ae64a952f198097))
* **branding:** use plugin icons in navbar ([38236dc](https://github.com/smsunarto/bb-plugins/commit/38236dc575513313b4241661c25886d23144a1eb))
* **gtd-sidebar,gitbutler:** resolve core from the local workspace ([e89b7cc](https://github.com/smsunarto/bb-plugins/commit/e89b7ccbb3ba90c11b1e1e99fe9b8f9e6b7e6a4f))
* **kitchen-sink,agentation:** play the completion sound in the browser and resolve embeds on the thread's host ([21b4bce](https://github.com/smsunarto/bb-plugins/commit/21b4bce93fdc4395d0ac6c8e72eb31ce1e16412a))
* **scott-engineering:** stop Arena rewrites repeating card labels ([69a5eb8](https://github.com/smsunarto/bb-plugins/commit/69a5eb8eaafc43c3d44c61e05bcc24ea6c6d2776))
* **storybook:** size component previews to content ([471d888](https://github.com/smsunarto/bb-plugins/commit/471d888914696829ee59ff1a84701fe2354fef90))


### Performance Improvements

* **agentation:** supervise the toolbar event stream and share snapshot reads ([2fb9621](https://github.com/smsunarto/bb-plugins/commit/2fb962155dacabace068273264ad0111eb8e8fed))
* **plugins:** narrow audited remaining utility scopes ([aeb6f69](https://github.com/smsunarto/bb-plugins/commit/aeb6f6993dd798316aab5eb83ae8bc106386bf63))

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
