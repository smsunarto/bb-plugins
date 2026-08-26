# Agentation staging-banner redesign proof

## Result

PASS after rebasing onto exact upstream base `d86a2645548ecf9b63f25ce3d202aea25fb468c5`.

- Branch: `bb/agentation-staging-banner-redesign`
- Committed scope: the staging banner and this report only
- The temporary `plugins/agentation/node_modules` preview symlink was removed.
- The upstream conflict was resolved by retaining the redesign while preserving the newer per-annotation mention and send actions, loading states, and accessible descriptions.
- A frozen install refreshed ignored dependencies after the upstream lockfile changed. No package or lockfile byte changed.

## Rendered proof

The original isolated preview imported the baseline component byte-for-byte from `a4198d1` and the original candidate from this branch.

- Desktop: `84px` before to `74.5625px` after, delta `-9.4375px`.
- 320px: `152.5625px` before to `98.5625px` after, delta `-54px`.
- 1 row: `74.5625px` at 780px, `98.5625px` at 320px, `74.5625px` at 200% zoom equivalent (390 CSS px).
- 3 rows: `147.6875px` at 780px, `171.6875px` at 320px and 200% zoom equivalent.
- 20 rows: bounded at `200px` at 780px and `224px` at 320px and 200% zoom equivalent.
- All nine 1/3/20-row reflow cases had no page/banner horizontal overflow, and all actions remained inside the viewport.

Screenshots use identical 220px-high crops:

- [Desktop before](/Users/juanbermudez/.bb-dev/desktop-kira-agent-d60736897699/thread-storage/thr_5wvxm9umwf/agentation-staging-banner-proof/before-780px.png)
- [Desktop after](/Users/juanbermudez/.bb-dev/desktop-kira-agent-d60736897699/thread-storage/thr_5wvxm9umwf/agentation-staging-banner-proof/after-780px.png)
- [320px before](/Users/juanbermudez/.bb-dev/desktop-kira-agent-d60736897699/thread-storage/thr_5wvxm9umwf/agentation-staging-banner-proof/before-320px.png)
- [320px after](/Users/juanbermudez/.bb-dev/desktop-kira-agent-d60736897699/thread-storage/thr_5wvxm9umwf/agentation-staging-banner-proof/after-320px.png)
- [Full browser results](/Users/juanbermudez/.bb-dev/desktop-kira-agent-d60736897699/thread-storage/thr_5wvxm9umwf/agentation-staging-banner-proof/proof-results.json)
- [Focus-close results](/Users/juanbermudez/.bb-dev/desktop-kira-agent-d60736897699/thread-storage/thr_5wvxm9umwf/agentation-staging-banner-proof/focus-results-rebased.json)

## Interaction and accessibility proof

- Keyboard order: `Discard all`, `Send to thread`, then each row's `Discard annotation`; the focus-visible ring resolved.
- Cancel, overlay click, and Escape each returned focus to `Discard all` through `DialogContent.onCloseAutoFocus` only.
- Successful bulk discard removed the banner without leaving focus in the closed dialog.
- Successful per-row discard removed the one-item banner; single-item `Discard all` remained hidden.
- Sending was disabled with `Sending…`; the error alert and Retry were visible and actionable.
- Reduced-motion spinner animation resolved to `none`.
- Dark, light, and custom semantic theme tokens resolved in the preview.

## Code checks

- Agentation tests: `98/98` pass after the upstream rebase.
- Agentation typecheck: pass.
- Agentation build: pass.
- Root typecheck, tests, lint, and build: pass after `bun install --frozen-lockfile` refreshed ignored dependencies for upstream's changed lockfile.
- `git diff --check`: pass.

## Proof ceiling

The original design was isolated-browser-proven on exact base `a4198d1`; the rebased candidate is package-tested, typechecked, and built on exact upstream `d86a2645`. The rebased row keeps the same measured height classes but adds upstream's two newer row actions, so the historical geometry is directional evidence rather than an exact post-rebase measurement. The rebased candidate was not live-bb- or browser-reverified. Native browser-chrome zoom was modeled as the equivalent 390 CSS-pixel viewport at 200%; no screen-reader or touch-device pass was performed.
