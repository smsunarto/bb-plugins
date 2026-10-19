---
name: reflect
description: Spawn three parallel review subthreads over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

Reviewers and the synthesizer run as BB subthreads. Read [subthreads.md](../../references/subthreads.md) for models, spawn flags, the prompt contract, and how to collect results.

## 1. Capture the active transcript

Write this thread's timeline to a file the reviewers can read:

```bash
dir=/tmp/reflect-$BB_THREAD_ID && mkdir -p "$dir"
bb thread log --self --format json --all > "$dir/transcript.json"
```

Use raw JSON events: the verbose timeline summarizes interactions and drops the user's answers. Read only this thread. Do not read other threads or other projects' transcripts. Outside BB, use this session's transcript file if you can identify it from its opening prompt. Otherwise pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

Spawn all three before ending the turn. Reviewers keep their MCP access so they can look up the tickets, chat threads, and observability traces the transcript references. Their prompts already forbid edits.

| Lens      | Model    | Prompt template                    |
| --------- | -------- | ---------------------------------- |
| Judgment  | Claude   | `references/judgment-reviewer.md`  |
| Tooling   | Codex    | `references/tooling-reviewer.md`   |
| Divergent | Claude   | `references/divergent-reviewer.md` |

Write each template verbatim to a prompt file, substituting the transcript path or digest where marked, then append the subthread contract. Reviewers return findings in their final reply.

## 3. Synthesize

Once all three have reported, copy `references/synthesizer.md` to the run directory, fill in each reviewer's full `bb thread output` where marked, and spawn one synthesizer on Claude with that prompt. It spot-verifies citations through MCP and returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit or filing any Backlog item. The user picks the subset and may redirect routings. Skill changes affect every future agent. Do not auto-apply.

Follow each approved row's Routing exactly. A routed `SKILL.md` path from the transcript may be an installed copy, such as a provider plugin cache. Resolve it to its source file first, for example in the dotfiles checkout or the owning repository, and edit only the source.

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines), `tune description: <skill path>`, or `new skill via create-skill: <kebab-name>`: follow the **dotfiles:skills** skill, which owns skill placement and routes writing guidance to Codex's skill creator. Do not invent a new skill's shape ad hoc.
- Approved Backlog items: file them where the user says, such as BB Tasks or a GitHub issue.

Run the repository's skill checks on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed: `<issue title>` (`<where>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
