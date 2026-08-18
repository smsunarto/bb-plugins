# @smsunarto/bb-plugin-t3sidebar

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
