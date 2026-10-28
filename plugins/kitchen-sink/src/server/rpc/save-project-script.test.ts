import { expect, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { saveProjectScriptInputSchema } from "../../shared/thread-details.ts";
import { projectScripts } from "./project-scripts.ts";
import { saveProjectScript } from "./save-project-script.ts";

function context() {
  const rows = new Map<string, unknown>();
  // Each storage call yields, so concurrent edits interleave as they would on the server.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  const bb = {
    storage: {
      kv: {
        get: async (key: string) => (await tick(), rows.get(key)),
        set: async (key: string, value: unknown) => (await tick(), void rows.set(key, value)),
        delete: async (key: string) => (await tick(), void rows.delete(key)),
      },
    },
  } as unknown as BbPluginApi;
  return { ctx: { bb }, rows };
}

const script = (id: string) => ({ id, name: `Script ${id}`, command: `echo ${id}` });
const list = async (ctx: ReturnType<typeof context>["ctx"]) =>
  (await projectScripts(ctx, { projectId: "p" })).scripts.map((entry) => entry.id);

test("two clients adding scripts at once both keep theirs", async () => {
  const { ctx } = context();
  await Promise.all([
    saveProjectScript(ctx, {
      projectId: "p",
      edit: { kind: "upsert", script: script("b") },
    }),
    saveProjectScript(ctx, {
      projectId: "p",
      edit: { kind: "upsert", script: script("c") },
    }),
  ]);
  expect(await list(ctx)).toEqual(["b", "c"]);
});

test("an edit replaces one script and a delete removes only its own", async () => {
  const { ctx, rows } = context();
  for (const id of ["a", "b"])
    await saveProjectScript(ctx, {
      projectId: "p",
      edit: { kind: "upsert", script: script(id) },
    });
  await saveProjectScript(ctx, {
    projectId: "p",
    edit: { kind: "upsert", script: { ...script("a"), name: "Renamed" } },
  });
  await saveProjectScript(ctx, { projectId: "p", edit: { kind: "delete", scriptId: "b" } });
  expect((await projectScripts(ctx, { projectId: "p" })).scripts).toEqual([
    { ...script("a"), name: "Renamed" },
  ]);
  await saveProjectScript(ctx, { projectId: "p", edit: { kind: "delete", scriptId: "a" } });
  expect(rows.size).toBe(0);
});

test("a script needs a name and a command", () => {
  const edit = (value: object) => ({ projectId: "p", edit: { kind: "upsert", script: value } });
  expect(saveProjectScriptInputSchema.safeParse(edit(script("s"))).success).toBe(true);
  for (const bad of [
    { id: "s", name: " ", command: "x" },
    { id: "s", name: "Dev", command: "" },
  ])
    expect(saveProjectScriptInputSchema.safeParse(edit(bad)).success).toBe(false);
});
