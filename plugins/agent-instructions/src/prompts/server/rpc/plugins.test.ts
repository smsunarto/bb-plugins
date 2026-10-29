import { expect, test } from "bun:test";
import { FILES, plugin } from "../../test/fixture.ts";
import { host } from "../../test/host.ts";

test("lists plugins with agent text, editable ones first, then by name", async () => {
  const { call } = await host([
    plugin(FILES, {
      id: "alpha",
      name: "Alpha",
      source: "git:https://x/y.git",
      sourceDisplay: "x/y",
    }),
    plugin({}, { id: "silent", name: "Silent", capabilities: [] }),
    plugin(FILES, { id: "zulu", name: "Zulu" }),
    plugin(FILES, { id: "mike", name: null }),
  ]);
  const { plugins } = (await call("plugins")) as { plugins: Array<{ id: string; name: string }> };
  expect(plugins.map((p) => [p.id, p.name])).toEqual([
    ["mike", "mike"],
    ["zulu", "Zulu"],
    ["alpha", "Alpha"],
  ]);
});
