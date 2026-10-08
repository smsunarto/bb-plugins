import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePlugin, readAgentFile, saveAgentFile } from "../src/server/lib/agent-text.ts";
import { FILES, plugin } from "./fixture.ts";

test("lists every tool and agent file, and which tool text lives in code", () => {
  expect(describePlugin(plugin(FILES))).toEqual({
    id: "notes",
    name: "Notes",
    status: "running",
    readOnly: null,
    tools: [
      {
        name: "notes_find",
        live: "Find a note.",
        file: "instructions/tools/notes_find.md",
        drift: false,
      },
      { name: "notes_code", live: "Defined in code.", file: null, drift: false },
    ],
    files: [
      { path: "instructions/open.md", kind: "prompt", tool: null, chars: 37 },
      {
        path: "instructions/tools/notes_find.instructions.md",
        kind: "tool-instructions",
        tool: "notes_find",
        chars: 22,
      },
      {
        path: "instructions/tools/notes_find.md",
        kind: "tool-description",
        tool: "notes_find",
        chars: 12,
      },
      { path: "skills/notes/SKILL.md", kind: "skill", tool: null, chars: 41 },
    ],
  });
});

test("flags a tool whose file no longer matches what the agent sees", () => {
  const p = plugin({ ...FILES, "instructions/tools/notes_find.md": "Find one note by title.\n" });
  expect(describePlugin(p)?.tools[0]?.drift).toBe(true);
});

test("skips plugins that give agents nothing", () => {
  expect(describePlugin(plugin({ "src/server.ts": "" }, { capabilities: [] }))).toBeNull();
});

test("a git or catalog install is read-only", () => {
  const p = plugin(FILES, {
    source: "git:https://example.com/x.git",
    sourceDisplay: "example.com/x",
  });
  expect(describePlugin(p)?.readOnly).toBe(
    "Installed from example.com/x. Install it from a local checkout to edit it.",
  );
  expect(() =>
    saveAgentFile(p, {
      pluginId: "notes",
      path: "instructions/open.md",
      previous: "",
      content: "x",
    }),
  ).toThrow("Install it from a local checkout");
});

test("reads a file with the placeholders its code fills", () => {
  const p = plugin(FILES);
  expect(readAgentFile(p, "instructions/open.md")).toEqual({
    content: "{{count}} notes are open in {{path}}.\n",
    placeholders: ["count", "path"],
    maxChars: null,
  });
  expect(readAgentFile(p, "skills/notes/SKILL.md").placeholders).toEqual([]);
  expect(readAgentFile(p, "instructions/tools/notes_find.instructions.md").maxChars).toBe(4096);
});

test("only names a listed agent file", () => {
  const p = plugin(FILES);
  expect(() => readAgentFile(p, "src/server.ts")).toThrow("notes has no agent file src/server.ts");
  expect(() => readAgentFile(p, "instructions/../src/server.ts")).toThrow("has no agent file");
  expect(() => readAgentFile(p, "instructions/notes.txt")).toThrow("has no agent file");
});

test("saves an edit, trimmed, with one trailing newline", () => {
  const p = plugin(FILES);
  saveAgentFile(p, {
    pluginId: "notes",
    path: "instructions/open.md",
    previous: FILES["instructions/open.md"],
    content: "  {{path}} has {{count}} open notes.\n\n",
  });
  expect(readFileSync(join(p.rootDir, "instructions/open.md"), "utf8")).toBe(
    "{{path}} has {{count}} open notes.\n",
  );
});

test("refuses an edit that drops or invents a placeholder", () => {
  const p = plugin(FILES);
  const save = (content: string) =>
    saveAgentFile(p, {
      pluginId: "notes",
      path: "instructions/open.md",
      previous: FILES["instructions/open.md"],
      content,
    });
  expect(() => save("{{count}} notes are open.")).toThrow(
    "The plugin's code fills a fixed set of placeholders. Put back {{path}}.",
  );
  expect(() => save("{{count}} notes in {{path}} for {{user}}.")).toThrow("Remove {{user}}.");
  expect(readFileSync(join(p.rootDir, "instructions/open.md"), "utf8")).toBe(
    FILES["instructions/open.md"],
  );
});

test("refuses an edit made over a file that changed on disk", () => {
  const p = plugin(FILES);
  expect(() =>
    saveAgentFile(p, {
      pluginId: "notes",
      path: "instructions/open.md",
      previous: "old text",
      content: "x",
    }),
  ).toThrow("instructions/open.md changed on disk since you opened it.");
});

test("enforces bb's limits on tool text", () => {
  const p = plugin(FILES);
  expect(() =>
    saveAgentFile(p, {
      pluginId: "notes",
      path: "instructions/tools/notes_find.md",
      previous: FILES["instructions/tools/notes_find.md"],
      content: "  ",
    }),
  ).toThrow("A tool needs a description.");
  expect(() =>
    saveAgentFile(p, {
      pluginId: "notes",
      path: "instructions/tools/notes_find.instructions.md",
      previous: FILES["instructions/tools/notes_find.instructions.md"],
      content: "x".repeat(4097),
    }),
  ).toThrow("bb rejects a tool snippet over 4096 characters; this one has 4097.");
});

test("skill text may use braces freely", () => {
  const p = plugin(FILES);
  saveAgentFile(p, {
    pluginId: "notes",
    path: "skills/notes/SKILL.md",
    previous: FILES["skills/notes/SKILL.md"],
    content: "---\nname: notes\n---\nNo braces now.",
  });
  expect(readAgentFile(p, "skills/notes/SKILL.md").content).toBe(
    "---\nname: notes\n---\nNo braces now.\n",
  );
});

test("a stopped plugin still lists its tool files", () => {
  const tools = describePlugin(plugin(FILES, { status: "disabled", capabilities: [] }))?.tools;
  expect(tools).toEqual([
    { name: "notes_find", live: null, file: "instructions/tools/notes_find.md", drift: false },
  ]);
});

test("a symlinked directory cannot reach files outside the plugin", () => {
  const outside = mkdtempSync(join(tmpdir(), "prompt-editor-outside-"));
  writeFileSync(join(outside, "secret.md"), "secret\n");
  const p = plugin({ "instructions/open.md": "Open.\n" });
  symlinkSync(outside, join(p.rootDir, "skills"));
  expect(describePlugin(p)?.files.map((f) => f.path)).toEqual(["instructions/open.md"]);
  expect(() => readAgentFile(p, "skills/secret.md")).toThrow(
    "notes has no agent file skills/secret.md",
  );
});
