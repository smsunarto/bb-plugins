# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Human reviewers who must understand a pull request before inspecting or approving its code. Large, agent-authored, and cross-cutting changes create the highest need.

## Product Purpose

Generate a local static pull-request guide that turns a file list into an ordered implementation story. Success means a reviewer can explain the intent, identify important seams, and inspect the correct evidence without reconstructing the change from alphabetical diffs.

## Positioning

The guide is narrative-first and diff-first. Semantic review groups define the workflow. Each group offers two readings of the same evidence: **Normal** preserves the familiar file-oriented diff, while **Guide** lets the model teach logically ordered excerpts with deeper rationale. Neither mode is a review verdict or a separate destination.

## Operating Context

Generate the guide from a repository checkout, PR metadata, Git patch, changed specifications, existing review comments, and available visual evidence. Use it locally before or during GitHub review.

## Capabilities and Constraints

- Ordered logical change groups with concise objectives, concrete summaries, and continuous inline diffs.
- A persistent Normal/Guide mode switch below group progress. Normal reviews files; Guide reviews model-authored logical excerpts. Completing either mode completes the group, while the two item-level progress sets remain independent.
- Guide phases use a fixed, sparse implementation vocabulary, omit empty phases, and account for every changed line exactly once. They may interleave excerpts from different files when that improves the teaching order.
- Guide explanations may include one optional, read-only React Flow diagram per phase and sparse, read-only Pierre line annotations only when they add non-obvious context.
- One canonical MDX file per review group; `index.mdx` owns PR metadata and reading order.
- Bordered Pierre Diffs surfaces with native whole-header collapse, Viewed-to-collapse behavior, Pierre line-info hunk treatment, and group-level bulk marking.
- Patch-only output by default. Exact old/new Git blobs from the locally generated canonical patch are an explicit, size-bounded, localhost-only build mode used solely to enable Pierre's native omitted-hunk expansion; opting out removes stale static bundles.
- One Pierre Tree directly under the center-column Changed files heading, with an explicit Show/Hide generated and binary shadcn toggle that includes faded secondary-evidence paths in the same tree.
- Trees fit visible content without internal scrolling, artificial minimum height, or leftover bottom gutter.
- Generated metadata, lockfiles, binary changes, and output remain reviewable. They are hidden from the Normal Tree by default, included through one generated/binary toggle, and rendered in a collapsed diff section after primary files. In Guide they appear as whole-file items in the final collapsed Generated output phase and do not affect Guide completion.
- Tests stay in the normal Changed files tree and diff flow instead of being repeated as a separate evidence section. Only relevant specs and links plus existing notes use the supporting rail.
- No secondary complete-patch destination, standalone conceptual-visualization mode, placeholder orientation section, generated findings, severity labels, approval decisions, merge controls, or fake chat.
- Nextra, actual shadcn Lyra components, Pierre Trees, Pierre Diffs, pnpm, Oxlint, and a static Next.js export.
- Self-hosted Berkeley Mono for code and monospaced metadata, using only locally licensed owner-supplied files and no remote font request.
- Shadcn selected-state, dense-row, and no-data primitives are part of the contract; do not replace them with styled look-alikes.
- Compiled JSON and patch-derived data are generated artifacts, never canonical authoring surfaces.

## Brand Commitments

Use a neutral product identity. Other review tools may inform hierarchy and workflow only. Do not copy names, logos, assets, proprietary fonts, finding workflows, or merge controls.

## Product Principles

- Make the diff the product center.
- Tell one ordered implementation story.
- Keep Normal file-oriented and unchanged; use Guide only for model-authored phase rationale, excerpt ordering, optional diagrams, and read-only line notes.
- Use selected card styling as the active-group indicator; do not repeat that state in an Active chip.
- Keep concise explanations next to inspectable evidence.
- Show progress as reviewed reading state, not judgment or approval.
- Make reviewed group progress unmistakable with a green `Reviewed · Normal + Guide` control and check icon while keeping the pending action neutral and naming its cross-mode scope explicitly.
- Surface local-progress loading, saved, and failed states. Keep failed saves in memory and offer Retry plus a copyable backup; never overwrite unreadable stored progress until the reviewer explicitly resets it.
- Keep supporting evidence visible as flat sibling sections and omit it entirely when empty.
- Let file Trees occupy only the height their rows need.
- Match Pierre’s native file-header and hunk rhythm while adapting colors to the walkthrough tokens, including yellow for modified files.
- Reuse one clipped, rounded, bordered review-surface treatment for diffs, the file Tree, and grouped supporting rows without wrapping flat sections in cards.
- Keep primary actions, persistent review controls, state badges, and segmented-control outer edges on one `rounded-md` control radius.
- Show Go to top only after the review document scrolls. Do not add Go to bottom.
- Keep orientation separate from review verdicts.

## Accessibility & Inclusion

Support keyboard navigation, visible focus, reduced motion, semantic landmarks, readable contrast, and responsive review flows from desktop workstations to narrow screens.
