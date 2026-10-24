import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";

test("the GitHub Stack tab keeps its saved identity as a thread action tab", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  assert.deepEqual(
    app.tabs.map(({ id, context, availability, title }) => ({ id, context, availability, title })),
    [{ id: "stack", context: { kind: "thread" }, availability: "action", title: "GitHub Stack" }],
  );
});
