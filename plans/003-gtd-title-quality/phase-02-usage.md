# Phase 2. Capture provider usage

[Plan overview](overview.md) · [Evaluation protocol](testing.md)

## Goal

Measure the cost of each inference instead of estimating it from character counts.

## Changes

- Extend `plugins/gtd-sidebar/lib/host-contract.ts` with optional measured usage on a successful completion.
- Carry completion-event usage through the SSE reader and `completeCodexInference` result in `plugins/gtd-sidebar/host/inference/chatgpt-client.ts`.
- Add `plugins/gtd-sidebar/test/inference-usage.test.ts` with realistic sanitized stream fixtures.

Keep absent provider fields absent. Do not inspect, print, or alter credential values. Preserve current request policy, title output, and fallback behavior. The evaluator can measure elapsed time around the call without a production timing framework.

## Data structures

`InferenceUsage` retains input, cached input, output, and reasoning token fields with explicit optionality. Its accounting rule prevents counting reasoning twice.

## Verification

Static: contract and stream parsing tests cover complete, missing, partial, and malformed usage metadata without losing a valid title.

Runtime: make one bounded tool-free inference through the isolated host and compare returned usage with the sanitized completion metadata. Count this probe in the evaluation budget. If the provider omits usage, exact prompt tokenization can establish input size only. Total-token equivalence stays unknown and blocks promotion. Do not substitute a character estimate.

Exit: observed usage or an explicit measurement blocker. No live naming policy change.
