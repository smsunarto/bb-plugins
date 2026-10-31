# @smsunarto/bb-plugin-gh-stack

## [0.4.0](https://github.com/smsunarto/bb-plugins/compare/gh-stack/v0.3.0...gh-stack/v0.4.0) (2026-10-31)


### Features

* **branding:** give every plugin a distinct BB-style icon ([e6a07fe](https://github.com/smsunarto/bb-plugins/commit/e6a07fe24cfd954203fc3007c3e9817de4b9376e))
* **plugins:** adopt BB 0.48 SDK APIs ([7fcbe74](https://github.com/smsunarto/bb-plugins/commit/7fcbe74366553e460c2992080af34533c7642649))
* **plugins:** replace plugin icons with Lucide via better-icons ([765f389](https://github.com/smsunarto/bb-plugins/commit/765f38988bcf8107889ec51890377f85c00dcdf3))
* **storybook:** catalog custom components across browser plugins ([1345a92](https://github.com/smsunarto/bb-plugins/commit/1345a926b6b281ae7ab0c6d7fcc6f1807130d77b))
* **storybook:** populate realistic review and workflow scenarios ([b58f4e7](https://github.com/smsunarto/bb-plugins/commit/b58f4e7b9865f3997da18c886de76aac7652db20))


### Bug Fixes

* **gh-stack:** keep prompt templates stable under oxfmt ([#146](https://github.com/smsunarto/bb-plugins/issues/146)) ([2aedd58](https://github.com/smsunarto/bb-plugins/commit/2aedd5863a4dc4e9f431bf09af2d9eddc909c74d))
* **gh-stack:** verify stack writes against the server's post-write stamp ([94f607a](https://github.com/smsunarto/bb-plugins/commit/94f607a328fd822d906c7e47afc2ece861323377))
* **scott-engineering:** stop Arena rewrites repeating card labels ([69a5eb8](https://github.com/smsunarto/bb-plugins/commit/69a5eb8eaafc43c3d44c61e05bcc24ea6c6d2776))
* **storybook:** size component previews to content ([471d888](https://github.com/smsunarto/bb-plugins/commit/471d888914696829ee59ff1a84701fe2354fef90))
* **workspace:** resolve in-repo core consumers locally ([8bc9ab7](https://github.com/smsunarto/bb-plugins/commit/8bc9ab7a9e6b7f8c18282fc3db697f7a7a138648))

## [0.3.0](https://github.com/smsunarto/bb-plugins/compare/gh-stack/v0.2.3...gh-stack/v0.3.0) (2026-09-15)


### Features

* **bb-kit:** support core and plugin dev workflows ([3e2ac94](https://github.com/smsunarto/bb-plugins/commit/3e2ac94a0408d6256f3ccc1e97c3f87858c25299))
* **gh-stack:** read the default branch from bb's environment instead of git origin/HEAD ([59b9406](https://github.com/smsunarto/bb-plugins/commit/59b940644c23c42939320188a0c3abfe54a51223))


### Bug Fixes

* **ci:** repair icon, skill, lint, and packaging checks ([6c13374](https://github.com/smsunarto/bb-plugins/commit/6c133744736b2fd6bf4c55bce7e3cc2f9adecf40))
* **plugins:** support bb 0.41 ([f2418f4](https://github.com/smsunarto/bb-plugins/commit/f2418f4c42786a7f5c8fce13e6d075a38b8eab71))

## 0.2.3

### Patch Changes

- 3da36f5: Support bb 0.40. The engines floor moves to the tested bb release (`>=0.40.0 <1.0.0`) and the plugin is built against plugin SDK 0.4.21.

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

- 65ececd: Release the runtime, presentation, notification, theme, and thread workflow updates.
