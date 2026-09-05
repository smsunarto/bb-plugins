# Phase 9. Integrate the measured winner

[Plan overview](overview.md) · [Evaluation protocol](testing.md)

## Goal

Use the winning policy in the existing server-owned naming flow without overwriting newer intent.

## Changes

- Wire completed context and canonical rule loading in `plugins/gtd-sidebar/thread-namer.ts`.
- Select the measured model/effort policy in `plugins/gtd-sidebar/thread-title-inference.ts` only if it changed.
- Extend `plugins/gtd-sidebar/test/thread-namer.test.ts` around the integration boundary.

Keep one authoritative pipeline for automatic and forced generation. Preserve the forced overwrite behavior and automatic optimistic title guard. Immediately before applying an automatic result, re-read naming events and require the latest non-retry user request sequence to equal the captured request sequence. Reject the result if a newer request exists, even when the title is unchanged. The current projected event shape exposes sequence numbers, so use that identity rather than assuming a request ID exists. Keep per-thread serialization and avoid extra summarization or grading calls.

Use `.agents/GTD_NAMING.md` as canonical. When only the existing `.agents/GTD_TITLE.md` exists, retain its documented behavior until explicit migration. If both exist, the new file wins without concatenation. This narrow compatibility is justified by existing external workspace configuration. Document it and remove it only after the supported migration boundary is met.

Remove rejected candidates and replace obsolete prompt/sanitizer branches in a separate two-file cleanup checkpoint if that would exceed this phase's three-file limit. Do not leave an experimental framework in the hot path.

## Data structures

`NamingSnapshotIdentity` ties an automatic inference to the completed user turn and observed title. Optional measurement records contain usage and policy identifiers, with prompt capture opt-in for local debugging. Measure end-to-end latency from the naming invocation before entering the per-thread queue until its write or terminal skip/failure. Keep inference service latency as a separate figure.

## Verification

Static: automatic versus forced behavior, rules precedence, queued requests, stale snapshot protection, and non-mutation on failure. Preserve the existing exclusion tests.

Runtime: use controlled dev-instance threads for automatic naming and forced generation. Edit one title while inference is pending, then begin a newer task during another inference. Confirm neither stale result overwrites current intent. Verify tool-free requests and measured cost.

Exit: the same winning evaluator behavior observed through the real server boundary.
