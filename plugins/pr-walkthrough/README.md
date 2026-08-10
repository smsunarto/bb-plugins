# bb-plugin-pr-walkthrough

A bb plugin that turns a pull request into a human-friendly review guide, rendered natively in a bb thread panel.

## What it ships

- **`pr-walkthrough` skill** (`skills/pr-walkthrough/`) — injected into agent threads. The agent groups a PR's changes into semantic review groups, authors canonical MDX under `.pr-walkthrough/walkthrough/`, and compiles it against the PR patch into `.pr-walkthrough/walkthrough.generated.json`. `scripts/compile_walkthrough.py` is the single producer of that file and the whole quality gate: it rejects duplicate group IDs, missing explanations, invalid Guide phase order, and any changed line not covered exactly once.
- **Generation workflow** (`skills/pr-walkthrough/workflow.js`) — one runtime-neutral script the skill launches with inline source, through bb's `bb_workflow_run` or Claude Code's `Workflow` tool. It stages generation across worker agents: Context (PR metadata, diff, evidence), Plan (semantic grouping with an exactly-once file-coverage check), Author (one agent per group, fanned out), Assemble (index.mdx + compile), and bounded Repair rounds. It ends at a successful compile. Prompts are laid out shared-prefix-first and kept deterministic, so sibling agents share a cached prefix and a resumed run (`resumeRunId` / `resumeFromRunId`) replays completed phases instead of re-running them. Without workflow tooling the skill falls back to the same steps inline.
- **Native viewer panel** (`app.tsx` + `server.ts`) — the only renderer. After a successful compile the agent emits a `::pr-walkthrough{path=".pr-walkthrough"}` directive. bb renders it as an **Open walkthrough** control that opens a thread panel rendering the compiled JSON natively: review groups, Normal/Guide modes, and real diffs via bb's own `@pierre/diffs` renderer. Nothing is bundled, hosted, or served, and it works when the workspace lives on a remote host.

## Install

```sh
npm install
bb plugin install .
```

`bb plugin dev` runs the rebuild/reload loop while developing.

## Repository layout

- `package.json` — bb plugin manifest.
- `server.ts` / `app.tsx` — plugin backend and frontend.
- `skills/pr-walkthrough/` — the skill, the compiler (`scripts/compile_walkthrough.py` + `guide_contract.py`), and the product/design references.
- `components/ui/`, `lib/`, `hooks/`, `types/` — vendored bb plugin scaffold support.

See `AGENTS.md` for the full product contract and development workflow.
