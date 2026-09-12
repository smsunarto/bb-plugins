# @smsunarto/bb-plugin-gtd-sidebar

## Unreleased

### Minor Changes

- Every shelf now groups its threads by project once more than one project is in
  view. A 26px header names the project, folds the group, and shows
  `needs-you / total` while folded; hovering it reveals a new-thread button for
  that project. Shelf headers stick while their rows scroll. The repo
  chip is gone from every row: the project lives in the group header (and on a
  card's second line), and a remote thread leads with its machine's globe
  instead. Pinned threads keep their own shelf above Next Action, grouped like the
  rest.
- Shelves now order by arrival instead of last update. A thread enters Pinned,
  Next Action, or Waiting at the top when it lands there and holds its place
  while it stays: a turn starting, a read, a rename, or subthread activity no
  longer reshuffles the list. Snoozed sorts by when you snoozed it and Settled
  by when it settled, both newest first.
- Project groups follow bb's own project order in every shelf, with the personal
  project last, so the same project sits in the same slot everywhere. A group
  header's right-click menu gains **Move up** and **Move down**, which reorder
  the project in bb itself rather than in the plugin.
- The Pinned shelf now follows bb's own pinned order — the same order the
  built-in sidebar drags by — instead of an arrival stamp. A pin moved in either
  sidebar ranks identically in both, and the shelf re-reads it when bb reports a
  pin change. Rows hold their arrival place only until bb's pin keys load.
- Settle is now bb's archive. The check button, the card menu, and a new
  **GTD Sidebar: settle thread** row in bb's quick palette archive the thread, and
  bb's Undo toast brings it back. The Settled shelf is now a view of bb's archive:
  it lists every thread archived in the last 24 hours, however it was archived, and
  un-settle unarchives it in bb. The automatic un-settle on new activity is gone;
  the plugin's database keeps only snoozes, and rows without a snooze are removed on
  the next start. Snooze is unchanged.

- Folding a family now writes bb's own `sidebar.collapsedThreads` preference
  instead of session state, so a fold made here shows in bb's built-in sidebar,
  a fold made there shows here, and both survive a reload. Folded project
  groups stay session state: bb has no per-shelf project key.

### Patch Changes

- Mobile rows now draw the compact desktop row: the project chip leads the title,
  and the trailing slot shows status or age with activity counts and the PR number
  beside it. The agent icon leaves the mobile row, as it already does on compact
  desktop rows.
- The browser-side warm-start cache is gone. The shelves wait for the plugin's own
  rows the same way they already wait for the Settled shelf, and the entries earlier
  versions left under `gtd-sidebar:v1:*` in `localStorage` are removed the first
  time this version loads. Provider names and marks now come from bb's own cached
  roster instead of a plugin round trip.

## [0.5.0](https://github.com/smsunarto/bb-plugins/compare/gtd-sidebar/v0.4.2...gtd-sidebar/v0.5.0) (2026-09-12)


### Features

* **bb-kit:** support core and plugin dev workflows ([3e2ac94](https://github.com/smsunarto/bb-plugins/commit/3e2ac94a0408d6256f3ccc1e97c3f87858c25299))
* **gtd-sidebar:** add compact rows and nested thread families ([b881625](https://github.com/smsunarto/bb-plugins/commit/b881625d16f77c56222c21d0cd47d3cbe9c2adb8))
* **gtd-sidebar:** add thread naming ([2b79e63](https://github.com/smsunarto/bb-plugins/commit/2b79e6335b8ff3e73867bff51e7a629cd056c736))
* **gtd-sidebar:** allow collapsing the Waiting shelf ([b50472c](https://github.com/smsunarto/bb-plugins/commit/b50472ca872c7f2f68c9002e9a0951f2c0aef58f))
* **gtd-sidebar:** bring back the Settled shelf as a view of bb's archive ([8b7387d](https://github.com/smsunarto/bb-plugins/commit/8b7387da9b440d6d170c9929b6d3514241beb8be))
* **gtd-sidebar:** color machine filters and repo chips ([adc5809](https://github.com/smsunarto/bb-plugins/commit/adc5809d79b7316f1d0fd4cd72ef820c6bac348e))
* **gtd-sidebar:** compact mobile thread cards ([6f632d9](https://github.com/smsunarto/bb-plugins/commit/6f632d97970626ff55dce53959f261b824d44294))
* **gtd-sidebar:** draw mobile rows like compact desktop rows ([b35e4a8](https://github.com/smsunarto/bb-plugins/commit/b35e4a8d2081baba0769ffa23b0493e96b33dfc4))
* **gtd-sidebar:** drive the Settled shelf off bb's archive change feed ([5da90c7](https://github.com/smsunarto/bb-plugins/commit/5da90c74f94f1170a141c7fe02886ffd3734d357))
* **gtd-sidebar:** drop the computer icon from local repo chips ([4114f49](https://github.com/smsunarto/bb-plugins/commit/4114f496c863aac0def235956ed5aa1bf1a16408))
* **gtd-sidebar:** fold families through bb's sidebar.collapsedThreads preference ([1b62fec](https://github.com/smsunarto/bb-plugins/commit/1b62fec62e230d517791c24f42da88c2e2caec18))
* **gtd-sidebar:** group every shelf by project ([29cef45](https://github.com/smsunarto/bb-plugins/commit/29cef454519ca98303be1d877e7edcd735688ebf))
* **gtd-sidebar:** improve scoped titles with compact context ([78aab5b](https://github.com/smsunarto/bb-plugins/commit/78aab5bb544a5372e0222442fec7eaea21b1de0a))
* **gtd-sidebar:** iOS long-press frosted menu on mobile ([08559f4](https://github.com/smsunarto/bb-plugins/commit/08559f4f91a2d3ca7041a58f4f64169e40b69424))
* **gtd-sidebar:** keep a family in Waiting while any subthread works ([aaf6048](https://github.com/smsunarto/bb-plugins/commit/aaf60483ce24f8c9011d7b7ed02334fd9003e25d))
* **gtd-sidebar:** make settle an alias for bb's archive and add it to the palette ([b97aaab](https://github.com/smsunarto/bb-plugins/commit/b97aaabbc215b4481e4ca49da0aa417bfecd95d2))
* **gtd-sidebar:** order project groups by bb project order + move up/down ([b3a848e](https://github.com/smsunarto/bb-plugins/commit/b3a848eed860a63eee0d8f82110c2f407e95ae32))
* **gtd-sidebar:** order the Pinned shelf by bb's pinSortKey ([98ddfc2](https://github.com/smsunarto/bb-plugins/commit/98ddfc210bacbd8278448fa344bfaa539f2fc160))
* **gtd-sidebar:** refresh titles after user turns ([a010c7a](https://github.com/smsunarto/bb-plugins/commit/a010c7abd71b744951e67db905e6a353aaeb765d))
* **gtd-sidebar:** remove the parent thread header chip ([db1ec16](https://github.com/smsunarto/bb-plugins/commit/db1ec161a4965c04dcd264d9f812004e9d56377a))
* **gtd-sidebar:** reorder compact menu actions and drop archive ([6883c93](https://github.com/smsunarto/bb-plugins/commit/6883c93ea2ce81b4281c2305cb207a58d62748d5))
* **gtd-sidebar:** sort every section by recent activity ([fe8556a](https://github.com/smsunarto/bb-plugins/commit/fe8556acee521fa8c4edd1b0964b8efa0b012f11))
* **gtd-sidebar:** sort shelves by arrival/snoozed/settled time ([bdb72f9](https://github.com/smsunarto/bb-plugins/commit/bdb72f97c079bbe32d0d2af4372d3a366923a511))
* **gtd-sidebar:** support project title instructions ([9da1aa8](https://github.com/smsunarto/bb-plugins/commit/9da1aa888849fe28e3a497b696da891dea941945))
* **gtd:** improve GTD Sidebar mobile usability ([#110](https://github.com/smsunarto/bb-plugins/issues/110)) ([b288159](https://github.com/smsunarto/bb-plugins/commit/b288159709a3eb258f53916aaab8edc83f230c6c))
* **kitchen-sink:** route native composer submissions ([142d037](https://github.com/smsunarto/bb-plugins/commit/142d0373484f9a1795f87cb0b9e238f039389105))


### Bug Fixes

* **gtd-sidebar:** align desktop menu with mobile ([171806d](https://github.com/smsunarto/bb-plugins/commit/171806d62174b2b2d2e731ce038d031453c0ebd4))
* **gtd-sidebar:** align menu and highlight with shared layer styling ([d4ad410](https://github.com/smsunarto/bb-plugins/commit/d4ad4100a62773d5a8c8667ef78e98f0264795a1))
* **gtd-sidebar:** ask for sentence-case thread titles ([97878eb](https://github.com/smsunarto/bb-plugins/commit/97878eb2b43cadd99e8b699c93b466a0a7a72040))
* **gtd-sidebar:** focus next thread after settle ([18d6c74](https://github.com/smsunarto/bb-plugins/commit/18d6c74d46415babc341e079fa22950167a6c08d))
* **gtd-sidebar:** indent compact rows by the group indent they render under ([f2a1414](https://github.com/smsunarto/bb-plugins/commit/f2a14148158371481c89a5ffca983ee1f403df56))
* **gtd-sidebar:** keep settles authoritative ([244c4a7](https://github.com/smsunarto/bb-plugins/commit/244c4a72c4cf3251bb4c5fe713ef30eb206b2dec))
* **gtd-sidebar:** make row highlights immediate and reduce sheet blur ([7fb2a11](https://github.com/smsunarto/bb-plugins/commit/7fb2a110767eeee5ffce2da6d9e11bffd3867159))
* **gtd-sidebar:** open settled threads ([7350ed3](https://github.com/smsunarto/bb-plugins/commit/7350ed34f8c68f9b5c515c4903209773ac8597a8))
* **gtd-sidebar:** scope the settle advance to the settled row's own shelf ([1b3a9b6](https://github.com/smsunarto/bb-plugins/commit/1b3a9b6d0c21d162f1903cbdb751d2f6f83bd3e4))
* **gtd-sidebar:** show newest waiting entries first ([1f30711](https://github.com/smsunarto/bb-plugins/commit/1f30711f4ed2eec3ddf0af98ce14c87816e3d394))
* **gtd-sidebar:** sort each section by the clock it can answer for ([70168ae](https://github.com/smsunarto/bb-plugins/commit/70168aef75565db89890257f5b9fb8c423835661))
* **gtd-sidebar:** sort projectless threads after every project group ([576f328](https://github.com/smsunarto/bb-plugins/commit/576f328a03fc37fc445713174f205f0b3d8e8fa6))
* **gtd-sidebar:** start local titles right after the disclosure column ([86e86ff](https://github.com/smsunarto/bb-plugins/commit/86e86ff9bdce344a5c2f12b47cc6a0c2ecb476e1))
* **gtd-sidebar:** support bb 0.41 ([2c97e1a](https://github.com/smsunarto/bb-plugins/commit/2c97e1ac7d3d52a03d399dc9e0404841ab13e3fe))
* **gtd-sidebar:** use Luna for thread naming ([1259aca](https://github.com/smsunarto/bb-plugins/commit/1259acaa32d2bce1815daccbcfbdb7571cefb407))
* **gtd-sidebar:** wake snoozes that elapsed while the rendered clock was stale ([094ff8c](https://github.com/smsunarto/bb-plugins/commit/094ff8c85f9d96fc8315d38dc09ec00272191f7c))
* **tooling:** clear repository quality gates ([4155137](https://github.com/smsunarto/bb-plugins/commit/41551375c36ac22a83daef851e065a8cf9c33151))
* **vimium:** settle the focused child pane ([ef2ccfd](https://github.com/smsunarto/bb-plugins/commit/ef2ccfd81e5ee6e764a12544b3797b6097bc3ea4))


### Performance Improvements

* **gtd-sidebar:** add refresh snapshot equality checks ([b782355](https://github.com/smsunarto/bb-plugins/commit/b782355cfa83b74431c80d2bb736c1d334c4bb6d))

## 0.4.2

### Patch Changes

- 3da36f5: Support bb 0.40. The engines floor moves to the tested bb release (`>=0.40.0 <1.0.0`) and the plugin is built against plugin SDK 0.4.21.
- 14254e6: Show the applied GitButler virtual branch instead of `gitbutler/workspace` on thread cards. When several virtual branches are applied, show their count rather than guessing one.

## 0.4.1

### Patch Changes

- 1432728: Support bb 0.39. The engines range is no longer pinned to one minor: it now floors at the tested bb release and excludes only the next major (`>=0.39.0 <1.0.0`), so future bb minors load without a plugin update. Built against plugin SDK 0.4.8.

## 0.4.0

### Minor Changes

- 1e0165e: Rename the plugin from t3sidebar to GTD Sidebar, id `gtd-sidebar`.

  bb keys a plugin by the id it derives from the package name, so this installs as
  a separate plugin rather than an update: install `gtd-sidebar`, then uninstall
  `t3sidebar`. Settled and snoozed shelves live in the old plugin's database and
  do not carry over. Releases are now tagged `gtd-sidebar/vX.Y.Z`.

  The warm-start cache moves to `gtd-sidebar:v1:*` in `localStorage`, and the
  first successful write removes the `t3sidebar:v1:*` entries — bb's uninstall
  does not clear web storage, and after the rename nothing else ever would.

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
