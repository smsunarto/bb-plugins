---
name: tool-descriptions
description: Write or review MCP and BB agent-tool descriptions when adding tools, changing their behavior or inputs, or improving tool selection and workflow guidance.
---

# Write tool descriptions

Use Figma's decision-oriented pattern: help the agent choose the tool, satisfy its prerequisites, interpret the result, and take the next step. Preserve our precise rules for revisions, ownership, retries, and side effects.

## Establish the contract

Read the tool's registration, input schema, implementation, and result shapes, plus neighboring tools and shared instructions. Verify every documented capability, default, limit, and recovery action against these sources. A description documents existing behavior; changing that behavior is a separate implementation decision.

For a rewrite, account for the old description's operational rules before removing or relocating them. Preserve authorization boundaries. Keep the edit scoped to the requested tools.

## Describe the decision and the call

Open with one or two sentences naming the user outcome and the tool's role in the workflow. Then cover the applicable topics below, in this order. Use short paragraphs for simple tools. For tools with branches, use uppercase section labels such as USE WHEN and BEFORE CALLING, with bullets underneath. Omit sections that add no decision-relevant information.

- **Use when:** Name concrete user intents or workflow states. Keep triggers within the tool's actual scope.
- **Choosing between tools:** Name overlapping tools. State the default, the exception, and which tool handles the adjacent case. For example, distinguish a standalone image request from generation using a saved canvas node.
- **Before calling:** Name required skills, lookups, claims, sessions, or revisions, and where to obtain them. Explain a prerequisite's purpose when it prevents a specific failure. Link detailed workflows through an available skill or instructions tool; use only fallback mechanisms the environment actually supports.
- **Inputs:** Explain where identifiers and paths come from and any meaningful combinations or precedence rules. Put field-specific semantics in schema descriptions when the registration can load their wording from instruction files; otherwise explain them here. Keep cross-field rules here. Avoid repeating the whole signature or enum list in prose.
- **Returns and next step:** Name the useful outputs and the tool that consumes them. Distinguish immediate completion, background work, pending approval, and failure when those states exist. State what the agent must inspect before proceeding.
- **Side effects and recovery:** Explain what is persisted, changed, published, or charged. Preserve concrete rules for stale revisions, idempotency keys, lost responses, polling, and cancellation. Distinguish stopping local waiting from cancelling upstream work when relevant.

Use exact tool and field names. Pair exceptional restrictions with the supported action: a stale revision calls for rereading and merging before retrying. Reserve MUST or NEVER for real requirements; explain routine selection with defaults and exceptions. Prefer short, locally relevant gotchas over an accumulating troubleshooting manual.

## Put guidance in the right layer

Follow [AGENTS.md](../../../AGENTS.md) for instruction-file storage and plugin verification. Keep each rule at the layer where the agent needs it:

- **Tool description:** Selection, essential prerequisites, call semantics, and result handling. A selected tool should expose the critical rules needed to use it correctly.
- **Thread snippet:** The trigger that makes the agent discover the tool before choosing it. Name the entry tool and point to detailed guidance. Stay within `TOOL_INSTRUCTIONS_MAX_CHARS` in the [instructions loader](../../../packages/bb-kit-core/src/instructions/instructions.ts); the host rejects oversized snippets.
- **Skill or instructions tool:** Longer workflows, recipes, and conditional reference material. Keep the prerequisite to load them visible in the tool description.

Repeat a critical prerequisite only where it must be visible independently. Share longer guidance through pointers instead of copying a server manual into every description. When inspecting an exposed MCP catalog, distinguish the individual description from shared server instructions and generated schema text before assessing length or duplication.

## Example: preview versus publication

This illustrates the structure for `html_preview`; it does not change that tool's current text:

```markdown
Preview an HTML page before publishing it with `html_render`. Returns a PNG,
contentHeight, and consoleMessages, plus missingImages when local images could
not be inlined. Inline styles and scripts. Absolute local image paths are
inlined; remote URLs load as-is. Follow the layout and theme rules in
`html_render`.

Inspect the PNG, consoleMessages, and any missingImages. Fix issues, then use
`html_render` to publish the finished page, passing contentHeight as its height.
```

## Verify the advertised guidance

Check that a reader can select the right tool, obtain every required input, recognize the result state, and continue or recover without guessing. Confirm named tools, skills, references, and field names exist. Check sibling descriptions for conflicting selection rules.

For changed tool descriptions, run the affected plugin's `check` script where present; bb-kit's check validates description wiring and snippet limits. Use existing catalog or registration checks to inspect the advertised text and schema together, then follow the repository's reload and handoff rules. Source Markdown alone does not prove the agent receives it. For a skill-only change, validate its frontmatter and links; no plugin reload is needed.
