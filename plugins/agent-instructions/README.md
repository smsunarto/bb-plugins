# Agent Instructions

Use **Rules** to manage scoped instructions. Use **Plugin prompts** to inspect and edit what your plugins tell agents: tool descriptions, tool thread snippets, prompts, and skills.

Open **Agent instructions → Plugin prompts** in the bb nav rail. Each installed plugin lists:

- **Tools**: every agent tool bb reports for the plugin. A tool backed by `instructions/tools/<tool>.md` is editable. A tool tagged **code** keeps its description in code and is shown read-only. A tool tagged **stale** has a file that differs from what agents currently see.
- **Prompts**: `instructions/*.md` files the plugin reads at runtime.
- **Skills**: `skills/**/*.md`.

**Save & reload** (⌘S) writes the file into the plugin's source directory and reloads the plugin, so new tool descriptions reach agents at once.

## Limits

- Only plugins installed from a local path are editable. A plugin installed from npm or Git is read-only, because a reinstall would discard the edit.
- A save fails if the file changed on disk since you opened it.
- `{{placeholders}}` are filled by the plugin's code. A save that adds or removes one is rejected.
- A tool thread snippet is capped at 4096 characters, the host limit.

## Making a plugin editable

Keep agent text in Markdown and read it with `@bb-plugins/instructions`:

```ts
import { instructionFiles } from "@bb-plugins/instructions";

const files = instructionFiles(import.meta.url);

bb.agents.registerTool({ name: "notes_find", ...files.tool("notes_find"), parameters, execute });
files.read("review-title", { count });
```

Include `instructions/` in the package's `files` list.
