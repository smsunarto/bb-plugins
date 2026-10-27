import { expect, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { projectScripts } from "./project-scripts.ts";

function context() {
  const rows = new Map<string, unknown>();
  const bb = {
    storage: { kv: { get: async (key: string) => rows.get(key) } },
  } as unknown as BbPluginApi;
  return { ctx: { bb }, rows };
}

test("a project with no saved scripts lists none", async () => {
  const { ctx } = context();
  expect(await projectScripts.execute(ctx, { projectId: "p" })).toEqual({ scripts: [] });
});

test("a malformed stored row reads as no scripts", async () => {
  const { ctx, rows } = context();
  rows.set("project-scripts:p", [{ name: "missing id" }]);
  expect(await projectScripts.execute(ctx, { projectId: "p" })).toEqual({ scripts: [] });
});
