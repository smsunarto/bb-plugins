# bb-plugin-pr-walkthrough

A bb plugin that turns a pull request into a human-friendly static review guide.

## What it ships

- **`pr-walkthrough` skill** (`skills/pr-walkthrough/`) — injected into agent threads. The agent groups a PR's changes into semantic review groups, authors canonical MDX, and builds a static Next.js/Nextra review site into `.pr-walkthrough/site/out/` in the thread's workspace. The skill directory also carries the reusable site template (`assets/site-template/`) and the scaffold/validate scripts it invokes.
- **Generation workflow** (`skills/pr-walkthrough/workflow.js`) — a bb workflow the skill launches through `bb_workflow_run` when workflow tooling is available. It stages generation across worker agents: Context (PR metadata, diff, evidence), Plan (semantic grouping with an exactly-once file-coverage check), Author (one agent per group, fanned out), Assemble (index.mdx + compile), bounded Repair rounds, and browser Validate. Without workflow tooling the skill falls back to the same steps inline.
- **Native viewer panel** (`app.tsx` + `server.ts`) — after a successful build the agent emits a `::pr-walkthrough{path=".pr-walkthrough/site"}` directive. bb renders it as an **Open walkthrough** control that opens a thread panel rendering the compiled walkthrough natively: review groups, Normal/Guide modes, and real diffs via bb's own `@pierre/diffs` renderer. No static-site hosting involved, and it works when the workspace lives on a remote host.

## Install

```sh
npm install
bb plugin install .
```

`bb plugin dev` runs the rebuild/reload loop while developing.

## Repository layout

- `package.json` — bb plugin manifest.
- `server.ts` / `app.tsx` — plugin backend and frontend.
- `skills/pr-walkthrough/` — the skill, its scripts, and the authoritative site template.
- `examples/rampage-client-pr-1634/` — preserved example walkthrough and design-evidence fixture.
- `components/ui/`, `lib/`, `hooks/`, `types/` — vendored bb plugin scaffold support.

See `AGENTS.md` for the full product contract and development workflow.
