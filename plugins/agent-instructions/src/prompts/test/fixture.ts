import { onTestFinished } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InstalledPlugin } from "../server/lib/agent-text.ts";

export function plugin(files: Record<string, string>, overrides: Partial<InstalledPlugin> = {}) {
  const root = mkdtempSync(join(tmpdir(), "prompt-editor-"));
  // Per test, not a module-level afterEach: bun runs this module once, so such a
  // hook would bind to the first test file that imports it and miss the rest.
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return {
    id: "notes",
    name: "Notes",
    rootDir: root,
    source: `path:${root}`,
    sourceDisplay: root,
    status: "running",
    capabilities: [
      { kind: "agent-tool", id: "notes_find", detail: "Find a note." },
      { kind: "agent-tool", id: "notes_code", detail: "Defined in code." },
      { kind: "skill", id: "notes", detail: "Skill this plugin adds to your agents" },
    ],
    ...overrides,
  } satisfies InstalledPlugin;
}

export const FILES = {
  "instructions/tools/notes_find.md": "Find a note.\n",
  "instructions/tools/notes_find.instructions.md": "Call notes_find first.\n",
  "instructions/open.md": "{{count}} notes are open in {{path}}.\n",
  "skills/notes/SKILL.md": "---\nname: notes\n---\nUse {{curly}} freely.\n",
  "instructions/notes.txt": "not markdown",
  "src/server.ts": "export {};",
};
