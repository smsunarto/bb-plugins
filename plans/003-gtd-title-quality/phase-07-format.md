# Phase 7. Evaluate phase and title formatting

[Plan overview](overview.md) · [Heuristics](heuristics.md)

## Goal

Make the agreed emoji, scope, and task visible without clipping away the subject.

## Changes

- Update candidate prompt and sanitization policy in `plugins/gtd-sidebar/lib/thread-naming.ts`.
- Update relevant checks in `plugins/gtd-sidebar/test/thread-naming.test.ts`.

Replace the 36-character/imperative/no-punctuation assumptions. Preserve questions and format `Emoji [Scope] Task`, with no emoji for exploration. Use grapheme-aware validation and truncation. A malformed or unusable result must not overwrite a useful existing title.

Use a finite activity vocabulary and explicit supplied evidence for readiness/shipment. Keep prompt evidence and eligibility checks in one named policy. Start with a title-string result. If parsing cannot enforce the contract reliably, benchmark a compact structured output before accepting the extra schema and token cost.

## Data structures

`NamingActivity` identifies the fixed activity meanings, including none, ready, and shipped. `TitleFormatPolicy` defines the candidate length and permitted display form. The ship-it evidence belongs to the current task context, not to a permanent thread-wide boolean.

## Verification

Static: question punctuation, multi-scope subject retention, grapheme boundaries, emoji vocabulary, and the shipping eligibility state transitions. Split the last group into its own small phase if it exceeds the phase test budget.

Runtime: render the interview examples in actual GTD cards and slim rows at two widths. Compare 48- and 64-grapheme candidates using screenshots and selection accuracy. Do not compensate for poor word order by making the sidebar wider.

Exit: a measured format candidate with zero false-shipped examples. Keep the defensive bound distinct from the preferred visual length.
