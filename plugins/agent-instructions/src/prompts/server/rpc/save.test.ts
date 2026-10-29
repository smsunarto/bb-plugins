import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILES, plugin } from "../../test/fixture.ts";
import { host } from "../../test/host.ts";

const PATH = "instructions/tools/notes_find.md";

test("a save writes the file and reloads the plugin that owns it", async () => {
  const notes = plugin(FILES);
  const { call, reloads } = await host([notes]);
  const input = { pluginId: "notes", path: PATH, previous: FILES[PATH], content: "Find notes." };
  expect(await call("save", input)).toEqual({ content: "Find notes.\n", reloadError: null });
  expect(readFileSync(join(notes.rootDir, PATH), "utf8")).toBe("Find notes.\n");
  expect(reloads).toEqual(["notes"]);
});

test("a failed reload keeps the saved file and says why", async () => {
  const notes = plugin(FILES);
  const { call } = await host([notes], async () => {
    throw new Error("notes failed to start");
  });
  const input = { pluginId: "notes", path: PATH, previous: FILES[PATH], content: "Find notes." };
  expect(await call("save", input)).toEqual({
    content: "Find notes.\n",
    reloadError: "notes failed to start",
  });
  expect(readFileSync(join(notes.rootDir, PATH), "utf8")).toBe("Find notes.\n");
});

test("a rejected save neither writes nor reloads", async () => {
  const notes = plugin(FILES);
  const { call, reloads } = await host([notes]);
  const input = { pluginId: "notes", path: PATH, previous: "stale", content: "Find notes." };
  await expect(call("save", input)).rejects.toThrow("changed on disk");
  expect(readFileSync(join(notes.rootDir, PATH), "utf8")).toBe(FILES[PATH]);
  expect(reloads).toEqual([]);
});
