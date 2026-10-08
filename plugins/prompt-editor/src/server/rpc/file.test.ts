import { expect, test } from "bun:test";
import { FILES, plugin } from "../../../test/fixture.ts";
import { host } from "../../../test/host.ts";

test("reads one agent file of an installed plugin", async () => {
  const { call } = await host([plugin(FILES)]);
  expect(await call("file", { pluginId: "notes", path: "instructions/open.md" })).toEqual({
    content: "{{count}} notes are open in {{path}}.\n",
    placeholders: ["count", "path"],
    maxChars: null,
  });
  await expect(call("file", { pluginId: "gone", path: "instructions/open.md" })).rejects.toThrow(
    "No installed plugin gone",
  );
});
