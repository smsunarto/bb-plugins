# My Stack

Scott's personal preference layer for capable coding agents. The prototype
contains short Markdown preferences and seven native skills that route to
them. The [constitution](CONSTITUTION.md) explains the design.

These are **user preferences**, not rules or a prescribed workflow. The agent
still chooses how to solve the task. The user's current request takes precedence.

## Shape

```text
my-stack/
├── CONSTITUTION.md                  # design intent
├── preferences/                     # living, editable preference files
│   ├── comms-lead-with-the-result.md # general preferences apply to all models
│   ├── go-library-defaults.md
│   ├── claude/                      # Claude Code refinements
│   │   └── comms-less-ceremony.md
│   └── codex/                       # Codex refinements
│       ├── tools-account-browser.md
│       └── astra/                   # Astra in Codex refinements
│           └── design-fable-second-opinion.md
├── skills/                          # small, hand-authored routing indexes
│   ├── my-comms-way/SKILL.md
│   ├── my-collaboration-way/SKILL.md
│   ├── my-code-way/SKILL.md
│   ├── my-go-way/SKILL.md
│   ├── my-design-way/SKILL.md
│   ├── my-demo-way/SKILL.md
│   └── my-tools-way/SKILL.md
└── src/server/server.ts             # headless bb-kit entry point
```

This is a selected tree. All preference filenames describe their subject.
The other files cover choices, evidence, scope, code ownership, replacements,
Go package and CLI shape, product fit, editable artifacts, demos, and tools.

## One preference

```markdown
---
way: my-go-way
description: Scott's preferences when choosing libraries or tools for Go code.
---

# Go library defaults

When the project leaves the choice open, prefer `zerolog` for logging...
```

`way` identifies the discoverable skill. `description` is the preference's
authored discovery trigger, including any task condition. A way's frontmatter
combines its preferences' triggers, and its body routes to their files. A
maintainer does not infer new triggers from prose. `status: trial` labels
proposed tuning, and the body repeats that status so it is clear when read.

Scope comes only from the path. No duplicate `scope` field or registry is
needed. For a relevant topic, root preferences apply to everyone. `claude/`
and `codex/` apply to the actual harness. Their model subdirectories refine
only that combination. Narrower preferences win where they conflict with a
parent. Known parents still apply when the model is unknown.

The manually written routers express each existing scope and task condition
explicitly. Fable and Opus can acquire files under `claude/fable/` and
`claude/opus/` when there is a distinct preference to put there. Sol currently
inherits the general and applicable harness preferences. We do not invent
differences just to populate a directory.

## Prototype installation

On this host, `~/.agents/preferences` points to this plugin's `preferences/`
directory. Edits through either path change the same files. Preferences stay
outside BB's generated skill cache, so reloading the plugin cannot reseed or
overwrite them. This local binding is a prototype choice, not an installer.

BB reads the seven skills through the manifest's `bb.skills` directory and
exposes them to its supported harnesses. The skill bodies refer directly to
`~/.agents/preferences`. Preference edits are immediately available to the
next file read. Changed routing metadata needs plugin reload and a new agent
session to be advertised reliably.

Installing the plugin alone on another host does not provision that host's
preference directory. It needs its own binding to the authored files. Standalone
Codex and Claude Code installation is also outside this BB prototype. Existing
AGENTS.md and installed skills remain active and may overlap with these drafts.

## Intentional limits

This prototype has no `index-ways`, maintenance skill, trigger inference,
automatic preference capture, model router, prompt injection hook, or startup
write to the user's home directory. Skill discovery is native to the harness.
The routers only name files and conditions, without sequencing other skills.

The Claude communication and desktop-tool refinements and the Astra design
refinement are trials from the current proposal. They are not benchmarked
claims about model quality or tool availability. The [source notes](SOURCES.md)
separate these from installed preferences and direct user corrections.

Ordinary plugin checks cover packaging and skill structure. They do not prove
that these preferences improve a model's output. The next iteration is to
review and use the format before automating its upkeep.
