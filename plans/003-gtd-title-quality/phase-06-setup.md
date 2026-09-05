# Phase 6. Evaluate one-time Luna max setup

[Plan overview](overview.md) · [Evaluation protocol](testing.md)

## Goal

Produce useful scope rules from bounded repository exploration once per repository.

## Changes

- Add `scripts/gtd-title-eval/setup.ts` for the explicit setup run and reviewable draft output.
- Refine `scripts/gtd-title-eval/setup-prompt.md` from development repositories only.
- Add `scripts/gtd-title-eval/setup.test.ts` for bounds, overwrite protection, and model identity.

The installed model metadata advertises `gpt-5.6-luna` with max reasoning. Verify availability through the chosen setup runner before execution. This is separate from the production title RPC, which accepts only none/low effort today. Do not silently replace the requested model or effort.

Let setup inspect bounded non-secret repository structure, manifests, display names, and a few relevant READMEs. Exclude title histories, test answers, credentials, generated assets, and dependency trees. Emit a local draft and provenance. Do not overwrite hand-edited configuration or explore again on every rename.

Run on bb-plugins, dotfiles, bb, and recipe first. Freeze the setup procedure before world-engine and pgo. The unregistered smsunarto.com checkout can become a later diversity check when a suitable task set exists.

## Data structures

`NamingSetupResult` contains rules, repository revision/source fingerprint, setup model/effort, measured usage, and inspected-source paths. Provenance stays outside the recurring prompt.

## Verification

Static: bounded source selection and refusal to overwrite an existing human file. Prove that setup and inference have different capabilities.

Runtime: compare generated scope labels with actual product names. Run held-out title cases without retuning the setup prompt. Report setup usage separately and compare generated rules with the existing bb-plugins rule file.

Exit: six bounded drafts or an explicit smaller completed set. Adoption remains a separate phase.
