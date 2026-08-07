# PR Walkthrough Repository Guide

## Purpose

This repository owns the `bb-plugin-pr-walkthrough` bb plugin, and the reusable `pr-walkthrough` skill it ships. The product helps a human understand a pull request in a deliberate semantic order. It is an orientation and reading-progress tool, not an automated code-review verdict.

Keep the diff as the primary surface. Do not add findings, severities, approval recommendations, merge controls, fake discussion, or vendor-specific branding.

## Source of Truth

- `package.json` is the bb plugin manifest (`bb.server`, `bb.app`, `bb.skills`).
- `server.ts` is the plugin backend: one RPC that reads a thread workspace's compiled `walkthrough.generated.json` (confined via `bb.sdk.files.read` with `rootPath`) and returns it typed.
- `app.tsx` is the plugin frontend: the `::pr-walkthrough{...}` message directive and the viewer thread-panel tab that renders review groups, explanations, and diffs natively with the host-shimmed `@pierre/diffs` renderer and the host `Markdown` component.
- `skills/pr-walkthrough/SKILL.md` defines agent behavior and the public product contract. bb injects it into agent threads as the plugin skills tier.
- `skills/pr-walkthrough/agents/openai.yaml` contains Codex skill-list metadata and must remain consistent with `SKILL.md`.
- `skills/pr-walkthrough/workflow.js` is the bundled workflow that orchestrates generation across worker agents (Context → Plan → Author → Assemble → Repair). It terminates at a successful compile and returns `built: true`. Nothing it returns may imply that rendering was viewed: no agent can see the panel. It is runtime-neutral: the same source runs under bb (`bb_workflow_run`, `bb workflows run`) and Claude Code (`Workflow`), so keep it to the shared `agent`/`parallel`/`pipeline`/`phase`/`log`/`args` contract and keep runner-specific reporting in `SKILL.md`. Only bb's own runner needs the emitted `::workflow-preview` directive to render; bb translates Claude Code's `local_workflow` task stream into a timeline row and composer card by itself, so a Claude Code `Workflow` run is visible in bb chat with no directive. `SKILL.md` prefers `bb_workflow_run` when both tools exist, because Claude Code's `resumeFromRunId` is same-session only while bb runs resume across sessions. Its worker prompts delegate the authoring contract to `SKILL.md`, so contract changes there must stay compatible with the workflow's phase boundaries, `args` (`skillDir`, `request`), and structured result schemas. The skill launches it with inline source because the installed skill directory lives outside thread workspaces. Validate edits with `bb workflows validate --script` against a running bb.
- `workflow.js` prompts are cache-shaped, and edits must preserve that. Every prompt starts with the same `PREAMBLE`, each phase's constant task block precedes its variable tail, and model-supplied file lists are sorted before they reach a prompt. That keeps a long shared prefix across the fanned-out Author agents and keeps every prompt deterministic, so a resumed run (`resumeRunId` / `resumeFromRunId`) replays the unchanged prefix of `agent()` calls from cache. Append to a prompt tail rather than rewriting a shared block, keep `label` values stable, and prefer adding work at the end of the script: renaming a label or editing an early phase invalidates every call after it.
- `skills/pr-walkthrough/scripts/compile_walkthrough.py` (with its `guide_contract.py` sibling) is the single producer of `walkthrough.generated.json` and the entire authoring quality gate. The two modules import each other by sibling path, so keep them together.
- `skills/pr-walkthrough/PRODUCT.md` and `DESIGN.md` define product and visual decisions. They predate the static site's removal, so any reading-progress, search, or keyboard behavior they describe is design intent, not current behavior.
- `skills/pr-walkthrough/scripts/migrate_monolith.py` splits a legacy single-file walkthrough into canonical multi-file MDX.
- `examples/rampage-client-pr-1634/` is a preserved example and design-evidence fixture. It is not the reusable product source.
- `components/ui/`, `lib/`, `hooks/`, and `types/` are vendored bb plugin scaffold support (shadcn model plus bundled SDK type declarations). Edit vendored components freely; refresh SDK types only from a matching bb release.

Never develop against an installed copy (`bb plugin list` path or `~/.codex/skills/pr-walkthrough`) and then copy changes back. Make changes here first. Update an installed copy only when the user explicitly asks to install or synchronize, and only after repository validation passes.

## Product Invariants

### One review path, two readings

- Semantic review groups define one ordered implementation story.
- Normal mode reviews complete changed files in authored group order.
- Guide mode reviews model-authored logical excerpts ordered by implementation dependency.
- Neither reading asserts correctness, safety, approval, or a completed code review. The product orients a reader; it never issues a verdict.

Reading progress (per-file and per-excerpt state, Mark reviewed, and its local-storage persistence) was implemented only by the removed static site. The viewer panel does not have it. Treat it as unbuilt product intent, not as behavior to describe or rely on.


### Canonical authoring

- Use one `index.mdx` for PR metadata and ordered section references.
- Use one MDX file per semantic review group.
- Put exactly one `## Guide` block in the same section file as its Normal metadata and explanation.
- Assign every changed file to exactly one group.
- Require every textual added and deleted line to appear exactly once across Guide excerpts. Context may repeat; selected changed lines may not overlap or be omitted.
- Allow one native Git hunk to be split across several logical excerpts.
- Use the fixed Guide phase vocabulary in this order, omitting empty phases:
  1. Foundations and data structures
  2. APIs and entrypoints
  3. Core behavior
  4. Integration and wiring
  5. Tests and verification
  6. Imports, formatting, and miscellaneous
  7. Generated output
- Make phase and excerpt prose substantive. Explain rationale, invariants, authority boundaries, tradeoffs, and reading order; do not paraphrase obvious code.

### Generated and binary evidence

- Keep generated, binary, lockfile, snapshot, and metadata changes viewable.
- Count them in Normal file progress.
- Put primary Normal diffs first and generated files in one collapsed section afterward.
- Put generated and binary Guide items in the final collapsed Generated output phase as whole-file items.
- Exclude generated and binary Guide items from the Guide completion numerator and denominator.
- Hide generated paths from the Changed files tree by default; one Show/Hide generated toggle includes faded rows in the same tree.

## Interface Contract

The bb viewer panel (`app.tsx`) is the only renderer. These rules bind it.

- Use bb's host-shimmed Pierre Trees for the active group's changed-file tree and Pierre Diffs for code.
- Preserve Pierre's native file header, icon, filename, status, totals, and hunk treatment.
- Keep Unified/Split as one shared preference across Normal and Guide.
- Render an authored Guide diagram read-only: no dragging, connecting, editing, or fake interaction. Do not reserve diagram space or add a separate visualization mode.
- Keep the diff document dominant. Use flat semantic sections; avoid nested cards, enclosing evidence containers, empty placeholders, and artificial minimum heights.
- Use blue for focus, links, explanation, and progress; yellow for modified files; green and red only for Git additions and deletions.
- Put primary Normal diffs first and generated files in one collapsed section afterward. Start the Guide miscellaneous and generated phases collapsed.
- Hide generated paths from the changed-file tree by default; one Show/Hide generated toggle includes faded rows in the same tree.
- Do not add phase jump links, a second file browser, review findings, severities, or merge controls.
- Inherit bb's theme tokens and fonts. The plugin ships no fonts of its own.

### Not implemented

The static site had reading progress, search, keyboard group navigation, resizable panels, a narrow-width navigation sheet, and local-storage persistence. None of it survived into the panel. Do not document these as current behavior. Building any of them is a deliberate new feature in `app.tsx`, and the compiled JSON carries no progress state to build on.

## Current Product Priorities

The `examples/rampage-client-pr-1634/critique/` and `audit/` material evaluated the removed static site. Keep it as historical design evidence; it is not an active backlog. Its still-relevant themes for the panel:

1. Preserve section and active Guide phase context while scrolling long reviews.
2. Decide whether reading progress returns to the panel, and design its scope before building it.
3. Preserve semantic landmarks, accessible names, focus visibility, and non-color status cues.

Do not resolve the long-review problem by turning the Guide outline into a jump-link dashboard. Prefer compact sticky context.


## Development Workflow

Work from the repository root. Preserve unrelated user changes and do not commit or push unless asked.

When editing the product:

1. Update `SKILL.md`, `PRODUCT.md`, `DESIGN.md`, and the compiler contract together when authoring rules change. The compiler is the enforcement point: a rule `SKILL.md` states but `compile_walkthrough.py` does not check is a rule that will be broken.
2. Update `app.tsx` when the rendering contract changes, and keep `server.ts`'s expected data shape in step with the compiler's output.
3. Never hand-edit `walkthrough.generated.json`; regenerate it.
4. Use official local package documentation or maintained upstream documentation before relying on a new or unstable API.

Compiler checks — compile the preserved example, which exercises Guide coverage, generated-file classification, and diff parsing end to end:

```bash
python3 skills/pr-walkthrough/scripts/compile_walkthrough.py \
  --input examples/rampage-client-pr-1634/walkthrough \
  --diff examples/rampage-client-pr-1634/changes.patch \
  --output /tmp/pr-walkthrough-example.json
```

It must exit zero and report 4 review groups and 39 diff files. Corrupt a section and confirm it exits non-zero: silent acceptance is the failure mode that matters.

Plugin checks (`server.ts`, `app.tsx`, manifest, vendored UI), from the monorepo root:

```bash
bun run --filter './plugins/pr-walkthrough' typecheck
bunx oxlint plugins/pr-walkthrough
```

Use `bb plugin dev` for a live rebuild/reload loop against a running bb, and `bb plugin logs pr-walkthrough -f` for backend logs.

Validate the skill package with the `skill-creator` `quick_validate.py` command when that tool is available. If its runtime lacks PyYAML, use a temporary validation environment rather than adding PyYAML to this product.

## Security

The compiled JSON stays in the thread workspace and is read through `bb.sdk.files.read` confined by `rootPath`. Nothing is bundled, hosted, or served.

- The default artifact is patch-only: it carries changed hunks, not whole files.
- `--include-full-context` embeds exact old/new Git blobs, up to 2 MB per side and 25 MB total, into the JSON. That file then holds full copies of private source. Use the flag only when the user asks for it, and regenerate without it before copying the JSON anywhere outside the workspace.
- Do not send private PR patches or code to a LAN, public host, or external service without explicit authorization.

## Verification Standard

Do not report a rendering change ready based only on source checks. Open the panel in bb against a freshly compiled walkthrough and verify the change.

No agent can see the panel from inside a workflow run. When rendering has not been inspected, say so rather than inferring it from the compiler exiting zero.
