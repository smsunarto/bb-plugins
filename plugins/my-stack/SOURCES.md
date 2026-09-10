# Prototype source notes

Curated on 2026-09-09 from the current request, installed guidance, the local
pstack source, and a bounded sample of recent Codex conversations. These are
human review notes. Routing skills do not load this file or raw traces.

## Direct preferences

| Preference files                                                | Source and interpretation                                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comms-*`                                                       | Current repository AGENTS.md and authored `.dotfiles/.agents/instructions/shared.md` in `~/git/dotfiles`. Distilled outcome-first, skimmable communication, concrete evidence, and comparable choices. Kept the intent without the full response templates.   |
| `collab-*`, `code-*`                                            | The same shared instructions, especially scope, candid judgment, ownership, and removing obsolete internal APIs. Selected personal tradeoffs without reproducing a general engineering checklist.                                                             |
| `go-*`                                                          | Installed `scott-engineering:go-development` and `scott-engineering:go-cli` from `~/.codex/plugins/cache/personal/scott-engineering/0.1.2/skills/`. Kept package, library, and CLI preferences. Omitted verification procedures.                              |
| `demo-*`                                                        | Installed `media:demo` from `~/.codex/plugins/cache/personal/media/0.1.0/skills/demo/SKILL.md` and current AGENTS.md. Kept real footage, inline delivery, editable artifacts, and the preferred capture rate. Left recording mechanics in the existing skill. |
| `design-fit-the-product.md`                                     | Current BB project instructions plus installed `emil-design-eng`. Kept product consistency, familiar components, and purposeful motion. Omitted its mandatory review format and animation decision sequence.                                                  |
| `tools-fit-my-environment.md`, `codex/tools-account-browser.md` | Current shared and Codex-specific instructions, cross-checked against `.dotfiles/.agents/instructions/{shared,codex}.md` in dotfiles. Kept personal environment choices without copying operational manuals.                                                  |

The installed `scott-engineering:show-me` skill informed the compact visual
presentation preference. Codex's installed
`~/.codex/skills/.system/skill-creator/SKILL.md` informed the authored format:
assume competence, preserve scope, keep discovery precise, disclose detail
progressively, and avoid unnecessary procedure.

## Recent user corrections

Read the user messages from these local Codex traces dated 2026-09-09. Their
recorded model was `gpt-6-astra`. A preference expressed to Astra is not by
itself evidence that the preference belongs only to Astra.

| Session ID                             | Direct signal                                                                                                                               | Where it appears                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `01a08888-f41f-7f93-985e-f3a7f064dd71` | Asked for explicit input/output handoffs, visible subagent ownership, bullet points, and finally just the flowchart while reviewing pstack. | `comms-show-the-evidence.md` and concise routing instead of a workflow diagram. |
| `01a0891c-525a-7282-ab96-257a44697157` | Asked how Codex implements change capture, then requested a tl;dr of the resulting design.                                                  | `comms-lead-with-the-result.md` and `comms-show-the-evidence.md`.               |
| `01a0890b-cb95-7273-98b4-15c7745a558a` | Requested evidence in a canvas, file-backed comments and proposals, direct agent editing, and individual acceptance of changes.             | `design-files-are-an-interface.md`.                                             |

This was a qualitative sample, not an exhaustive trace audit or a model
comparison. Automated approval-review messages and generated demo prompts
were excluded from preference evidence. No trace contents are shipped with
the plugin.

## Inspiration and trials

Read the local pstack source at
`~/git/dotfiles/.dotfiles/.agents/plugins/pstack/vendor/skills/poteto-mode/SKILL.md`.
It combines preferences with principle loading, delegated design exploration,
and staged playbooks. My Stack retains the idea of personal agent style while
following the current request's different constitution. No pstack workflow,
orchestration script, or router was copied.

The current request supplies three illustrative tuning ideas. They are
included as editable trials rather than findings from the trace sample:

- `claude/comms-less-ceremony.md`: stronger emphasis on direct communication.
- `claude/tools-cua-driver.md`: prefer an available `cua_driver` for native
  desktop interaction. The prototype neither installs nor validates a driver.
- `codex/astra/design-fable-second-opinion.md`: try a Fable or Opus contribution
  for substantial UI design, initially scoped to Astra in Codex to exercise
  the third level. It is not applied to every OpenAI model based on inference.

The distinction between measured success and personal fit in the constitution
is a product premise. The prototype does not claim to establish how a lab
trains its models or that a trial preference improves performance.
