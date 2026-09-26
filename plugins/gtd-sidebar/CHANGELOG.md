# @smsunarto/bb-plugin-gtd-sidebar

## Unreleased

### Minor Changes

- Remove Cursor Projects coordination, its sidebar rail and panels, shared-context
  tools, and subscriptions. Native threads remain in the ordinary inbox.

- Restore bb's native thread actions in the desktop right-click menu. Settle and
  Snooze stay first, and Archive stays excluded. Add Open in split, Copy thread
  link, Mark read/unread, and Rename alongside Pin and Delete.
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
- Drag a row onto another row to nest it there, or onto a project group header
  to lift it back to the top level. The drop is bb's own parent change
  (`threads.update({ parentThreadId })`), so bb's sidebar follows it, and a
  folded family opens to show what just landed in it. A row cannot drop onto
  itself, its current parent, its own descendants, or a thread in another
  project; the backend refuses the same cases. Space, the arrows, and Escape
  drive the same move from the keyboard. bb's drag-to-split keeps every drag
  that leaves the sidebar. Built on dnd-kit. Desktop only.
- Drag a project group header onto another group in the same shelf to reorder
  its project: the group lands where it was dropped, the shelves draw the move
  at once, and bb's own `reorderProject` write makes it real — so every shelf
  and `bb project list` agree on the new order, and a project with no rows in
  view is jumped identically from every shelf. The personal project's group
  never drags and nothing lands after it. The header's **Move up**/**Move
  down** menu stays as the keyboard path. The drag shares the row-nesting
  context, discriminated by payload kind, so a group can never read as a
  thread and a thread can never reorder a project. Desktop only.

### Patch Changes

- Match the touch project header's corner radius to the 12px thread rows.

- Machine-scoped inboxes now keep repository group headers visible even when
  only one repository remains in view. A persistent folder toggle beside the
  machine picker can disable or restore repository grouping for the sidebar.
  The project selector stays available in either grouping mode, and toggling
  groups preserves the selected project.
- Mobile rows now draw the compact desktop row: the project chip leads the title,
  and the trailing slot shows status or age with activity counts and the PR number
  beside it. The agent icon leaves the mobile row, as it already does on compact
  desktop rows.
- The browser-side warm-start cache is gone. The shelves wait for the plugin's own
  rows the same way they already wait for the Settled shelf, and the entries earlier
  versions left under `gtd-sidebar:v1:*` in `localStorage` are removed the first
  time this version loads. Provider names and marks now come from bb's own cached
  roster instead of a plugin round trip.

## [0.6.0](https://github.com/smsunarto/bb-plugins/compare/gtd-sidebar/v0.5.1...gtd-sidebar/v0.6.0) (2026-09-26)


### Features

* **gtd-sidebar:** adopt bb 0.44 sidebar APIs and port thread-list parity ([abc2211](https://github.com/smsunarto/bb-plugins/commit/abc221165322c3790af1a229ce1fcf36784d27cf))
* **gtd-sidebar:** draw bb's row jump keys and read the worktree flag ([c12af29](https://github.com/smsunarto/bb-plugins/commit/c12af292f259029fa21b8c29c73293fc399ab6dc))
* **gtd-sidebar:** draw the queued-message glyphs ([15db145](https://github.com/smsunarto/bb-plugins/commit/15db14559624501527a17d5cc9bfcfc99134f491))
* **gtd-sidebar:** liquid-glass thread menus ([eae260c](https://github.com/smsunarto/bb-plugins/commit/eae260cae8624508bd69d653d3e786576e08d529))


### Bug Fixes

* **gtd-sidebar:** name threads through bb 0.44's Codex transport ([ae2577e](https://github.com/smsunarto/bb-plugins/commit/ae2577ec0b5ea9a6a4ac8f92cac5c214b23b6099))
* **gtd-sidebar:** refresh only shelves affected by deletion ([1a7ed19](https://github.com/smsunarto/bb-plugins/commit/1a7ed19f3748d661060b2de35aa1e799ba51b563))
* **gtd-sidebar:** satisfy the SDK 0.5.9 sidebar thread shape ([4089838](https://github.com/smsunarto/bb-plugins/commit/408983815dd8d8ad0ab88f90f4b866ae372f56a1))
* **gtd-sidebar:** snooze thread families together ([654681d](https://github.com/smsunarto/bb-plugins/commit/654681d034f5e25b7d987f0c8ed8a3c4118a72aa))
* **gtd-sidebar:** use GPT-6-Luna for thread titles ([b31c309](https://github.com/smsunarto/bb-plugins/commit/b31c3094cd7bec04c77feaaea72f792310af29de))

## [0.5.1](https://github.com/smsunarto/bb-plugins/compare/gtd-sidebar/v0.5.0...gtd-sidebar/v0.5.1) (2026-09-22)


### Bug Fixes

* **gtd-sidebar:** prevent clean-install frontend build failures ([f387dee](https://github.com/smsunarto/bb-plugins/commit/f387dee883cdcec50506ffbc953bfaca59589e76))

## [0.5.0](https://github.com/smsunarto/bb-plugins/compare/gtd-sidebar/v0.4.2...gtd-sidebar/v0.5.0) (2026-09-15)


### Features

* **bb-kit:** support core and plugin dev workflows ([3e2ac94](https://github.com/smsunarto/bb-plugins/commit/3e2ac94a0408d6256f3ccc1e97c3f87858c25299))
* **gtd-sidebar:** add compact rows and nested thread families ([b881625](https://github.com/smsunarto/bb-plugins/commit/b881625d16f77c56222c21d0cd47d3cbe9c2adb8))
* **gtd-sidebar:** add Projects coordination and subscriptions ([db8aa6b](https://github.com/smsunarto/bb-plugins/commit/db8aa6b9458816e9024f4b0555f8f5b74bbcf402))
* **gtd-sidebar:** add thread naming ([2b79e63](https://github.com/smsunarto/bb-plugins/commit/2b79e6335b8ff3e73867bff51e7a629cd056c736))
* **gtd-sidebar:** allow collapsing the Waiting shelf ([b50472c](https://github.com/smsunarto/bb-plugins/commit/b50472ca872c7f2f68c9002e9a0951f2c0aef58f))
* **gtd-sidebar:** bring back the Settled shelf as a view of bb's archive ([8b7387d](https://github.com/smsunarto/bb-plugins/commit/8b7387da9b440d6d170c9929b6d3514241beb8be))
* **gtd-sidebar:** color machine filters and repo chips ([adc5809](https://github.com/smsunarto/bb-plugins/commit/adc5809d79b7316f1d0fd4cd72ef820c6bac348e))
* **gtd-sidebar:** compact mobile thread cards ([6f632d9](https://github.com/smsunarto/bb-plugins/commit/6f632d97970626ff55dce53959f261b824d44294))
* **gtd-sidebar:** drag a thread onto another to nest it ([948b878](https://github.com/smsunarto/bb-plugins/commit/948b878ceca7a23be7519fa7c80ccd00b3306507))
* **gtd-sidebar:** drag project groups to reorder ([ab648f1](https://github.com/smsunarto/bb-plugins/commit/ab648f10b4123935218ba37e28c079d15510ee8d))
* **gtd-sidebar:** draw mobile rows like compact desktop rows ([b35e4a8](https://github.com/smsunarto/bb-plugins/commit/b35e4a8d2081baba0769ffa23b0493e96b33dfc4))
* **gtd-sidebar:** drive the Settled shelf off bb's archive change feed ([5da90c7](https://github.com/smsunarto/bb-plugins/commit/5da90c74f94f1170a141c7fe02886ffd3734d357))
* **gtd-sidebar:** drop the computer icon from local repo chips ([4114f49](https://github.com/smsunarto/bb-plugins/commit/4114f496c863aac0def235956ed5aa1bf1a16408))
* **gtd-sidebar:** fold families through bb's sidebar.collapsedThreads preference ([1b62fec](https://github.com/smsunarto/bb-plugins/commit/1b62fec62e230d517791c24f42da88c2e2caec18))
* **gtd-sidebar:** group every shelf by project ([29cef45](https://github.com/smsunarto/bb-plugins/commit/29cef454519ca98303be1d877e7edcd735688ebf))
* **gtd-sidebar:** improve scoped titles with compact context ([78aab5b](https://github.com/smsunarto/bb-plugins/commit/78aab5bb544a5372e0222442fec7eaea21b1de0a))
* **gtd-sidebar:** iOS long-press frosted menu on mobile ([08559f4](https://github.com/smsunarto/bb-plugins/commit/08559f4f91a2d3ca7041a58f4f64169e40b69424))
* **gtd-sidebar:** keep a family in Waiting while any subthread works ([aaf6048](https://github.com/smsunarto/bb-plugins/commit/aaf60483ce24f8c9011d7b7ed02334fd9003e25d))
* **gtd-sidebar:** make optional enhancements opt-in ([8afde85](https://github.com/smsunarto/bb-plugins/commit/8afde851d1f3991de1874d14cec75fe8ede65433))
* **gtd-sidebar:** make settle an alias for bb's archive and add it to the palette ([b97aaab](https://github.com/smsunarto/bb-plugins/commit/b97aaabbc215b4481e4ca49da0aa417bfecd95d2))
* **gtd-sidebar:** move project grouping to plugin settings ([5d35274](https://github.com/smsunarto/bb-plugins/commit/5d35274698b355f8468b9e72dc1d254c8843df5f))
* **gtd-sidebar:** order project groups by bb project order + move up/down ([b3a848e](https://github.com/smsunarto/bb-plugins/commit/b3a848eed860a63eee0d8f82110c2f407e95ae32))
* **gtd-sidebar:** order the Pinned shelf by bb's pinSortKey ([98ddfc2](https://github.com/smsunarto/bb-plugins/commit/98ddfc210bacbd8278448fa344bfaa539f2fc160))
* **gtd-sidebar:** refresh titles after user turns ([a010c7a](https://github.com/smsunarto/bb-plugins/commit/a010c7abd71b744951e67db905e6a353aaeb765d))
* **gtd-sidebar:** remove the parent thread header chip ([db1ec16](https://github.com/smsunarto/bb-plugins/commit/db1ec161a4965c04dcd264d9f812004e9d56377a))
* **gtd-sidebar:** reorder compact menu actions and drop archive ([6883c93](https://github.com/smsunarto/bb-plugins/commit/6883c93ea2ce81b4281c2305cb207a58d62748d5))
* **gtd-sidebar:** restore native thread context actions ([4a2f1d2](https://github.com/smsunarto/bb-plugins/commit/4a2f1d2e9e2237224277316c15b7d945a59ab134))
* **gtd-sidebar:** share existing checkouts in Projects ([ce917ea](https://github.com/smsunarto/bb-plugins/commit/ce917ea73ce4c4b8dc8684329f56bfd95fec8950))
* **gtd-sidebar:** shimmer titles while naming ([ba4ef46](https://github.com/smsunarto/bb-plugins/commit/ba4ef461070135fc95530f32876192591743a977))
* **gtd-sidebar:** sort every section by recent activity ([fe8556a](https://github.com/smsunarto/bb-plugins/commit/fe8556acee521fa8c4edd1b0964b8efa0b012f11))
* **gtd-sidebar:** sort shelves by arrival/snoozed/settled time ([bdb72f9](https://github.com/smsunarto/bb-plugins/commit/bdb72f97c079bbe32d0d2af4372d3a366923a511))
* **gtd-sidebar:** support project title instructions ([9da1aa8](https://github.com/smsunarto/bb-plugins/commit/9da1aa888849fe28e3a497b696da891dea941945))
* **gtd:** improve GTD Sidebar mobile usability ([#110](https://github.com/smsunarto/bb-plugins/issues/110)) ([b288159](https://github.com/smsunarto/bb-plugins/commit/b288159709a3eb258f53916aaab8edc83f230c6c))
* **kitchen-sink:** route native composer submissions ([142d037](https://github.com/smsunarto/bb-plugins/commit/142d0373484f9a1795f87cb0b9e238f039389105))


### Bug Fixes

* **gtd-sidebar:** align desktop menu with mobile ([171806d](https://github.com/smsunarto/bb-plugins/commit/171806d62174b2b2d2e731ce038d031453c0ebd4))
* **gtd-sidebar:** align menu and highlight with shared layer styling ([d4ad410](https://github.com/smsunarto/bb-plugins/commit/d4ad4100a62773d5a8c8667ef78e98f0264795a1))
* **gtd-sidebar:** align thread and repository columns ([c4cdaca](https://github.com/smsunarto/bb-plugins/commit/c4cdaca28a25596e22a91fccbb07842759173444))
* **gtd-sidebar:** ask for sentence-case thread titles ([97878eb](https://github.com/smsunarto/bb-plugins/commit/97878eb2b43cadd99e8b699c93b466a0a7a72040))
* **gtd-sidebar:** bundle private inference dependency at build time ([1b83f5c](https://github.com/smsunarto/bb-plugins/commit/1b83f5c5c1b67b28565c621bfe751dc631264d35))
* **gtd-sidebar:** clarify sidebar tree affordances ([3cf9e76](https://github.com/smsunarto/bb-plugins/commit/3cf9e765185688ea1e4ba5332d6985da33e4e3f8))
* **gtd-sidebar:** control repository groups ([63581b5](https://github.com/smsunarto/bb-plugins/commit/63581b5377c8f3694608a66e0fd6e1daaf7f4090))
* **gtd-sidebar:** enlarge folder and chevron targets on mobile ([521e81f](https://github.com/smsunarto/bb-plugins/commit/521e81fee1089458749f7ba9c249a97a0386cde3))
* **gtd-sidebar:** focus next thread after settle ([18d6c74](https://github.com/smsunarto/bb-plugins/commit/18d6c74d46415babc341e079fa22950167a6c08d))
* **gtd-sidebar:** harden subscriptions and refresh paths ([ffa655a](https://github.com/smsunarto/bb-plugins/commit/ffa655a266a277c83d9b619e11a9240ff3d48f19))
* **gtd-sidebar:** indent compact rows by the group indent they render under ([f2a1414](https://github.com/smsunarto/bb-plugins/commit/f2a14148158371481c89a5ffca983ee1f403df56))
* **gtd-sidebar:** keep host SDK out of frontend helpers ([8f280c6](https://github.com/smsunarto/bb-plugins/commit/8f280c67018164f7e4d7c4e466ee65073836659b))
* **gtd-sidebar:** keep project filter available with groups ([44d64f1](https://github.com/smsunarto/bb-plugins/commit/44d64f17a9cffc005e450032a633baaffdacbaf0))
* **gtd-sidebar:** keep settles authoritative ([244c4a7](https://github.com/smsunarto/bb-plugins/commit/244c4a72c4cf3251bb4c5fe713ef30eb206b2dec))
* **gtd-sidebar:** keep tree guide color stable across row states ([ce60528](https://github.com/smsunarto/bb-plugins/commit/ce60528e1acbd0dd91bafd91f84e8a7c7e7a470d))
* **gtd-sidebar:** make row highlights immediate and reduce sheet blur ([7fb2a11](https://github.com/smsunarto/bb-plugins/commit/7fb2a110767eeee5ffce2da6d9e11bffd3867159))
* **gtd-sidebar:** match project group row height ([ad289ab](https://github.com/smsunarto/bb-plugins/commit/ad289ab393eea95b697d8179ffda140992c26670))
* **gtd-sidebar:** match touch project header radius to thread rows ([415a6f2](https://github.com/smsunarto/bb-plugins/commit/415a6f239fa62732ff82fe93866f470f51fa2f09))
* **gtd-sidebar:** open settled threads ([7350ed3](https://github.com/smsunarto/bb-plugins/commit/7350ed34f8c68f9b5c515c4903209773ac8597a8))
* **gtd-sidebar:** remove move section menu ([f6c81d6](https://github.com/smsunarto/bb-plugins/commit/f6c81d6615fd7742eed1944433615c3112098479))
* **gtd-sidebar:** render Project agents as subthreads ([3f98836](https://github.com/smsunarto/bb-plugins/commit/3f98836c86b96c7d5704e4012878274c5142be30))
* **gtd-sidebar:** scope the settle advance to the settled row's own shelf ([1b3a9b6](https://github.com/smsunarto/bb-plugins/commit/1b3a9b6d0c21d162f1903cbdb751d2f6f83bd3e4))
* **gtd-sidebar:** show folders off hover and reduce nesting ([4b75a26](https://github.com/smsunarto/bb-plugins/commit/4b75a261f139bcd5b9a949e1be6ebf8e4d8ebb70))
* **gtd-sidebar:** show newest waiting entries first ([1f30711](https://github.com/smsunarto/bb-plugins/commit/1f30711f4ed2eec3ddf0af98ce14c87816e3d394))
* **gtd-sidebar:** sort each section by the clock it can answer for ([70168ae](https://github.com/smsunarto/bb-plugins/commit/70168aef75565db89890257f5b9fb8c423835661))
* **gtd-sidebar:** sort projectless threads after every project group ([576f328](https://github.com/smsunarto/bb-plugins/commit/576f328a03fc37fc445713174f205f0b3d8e8fa6))
* **gtd-sidebar:** start local titles right after the disclosure column ([86e86ff](https://github.com/smsunarto/bb-plugins/commit/86e86ff9bdce344a5c2f12b47cc6a0c2ecb476e1))
* **gtd-sidebar:** support bb 0.41 ([2c97e1a](https://github.com/smsunarto/bb-plugins/commit/2c97e1ac7d3d52a03d399dc9e0404841ab13e3fe))
* **gtd-sidebar:** synchronize committed context editor state ([b12863e](https://github.com/smsunarto/bb-plugins/commit/b12863e804e908f7013d8c1abc2a0f8f0f12c6e4))
* **gtd-sidebar:** use Luna for thread naming ([1259aca](https://github.com/smsunarto/bb-plugins/commit/1259acaa32d2bce1815daccbcfbdb7571cefb407))
* **gtd-sidebar:** wait for naming rules and retry supported model ([7775ca3](https://github.com/smsunarto/bb-plugins/commit/7775ca3993727176bac51744a3cf4605cabc2fca))
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
