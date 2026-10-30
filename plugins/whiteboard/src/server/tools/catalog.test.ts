import { readFileSync, writeFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test } from "vitest";
import type { Engine } from "../../shared/contracts/engine.ts";
import { files } from "../lib/instructions.ts";
import { createSettings } from "../lib/settings.ts";
import { registerTools } from "./registry.ts";

/**
 * The catalog bb advertises, pinned: names, descriptions and input schemas
 * with the scratchpad off, plus the descriptions the setting changes. To
 * accept a deliberate change, run this file with UPDATE_WHITEBOARD_GOLDEN=1,
 * format the golden with oxfmt, and review its diff.
 */
const GOLDEN = new URL("./catalog.golden.json", import.meta.url);

type Advertised = { name: string; description: string; inputSchema: unknown };
type Golden = { tools: Advertised[]; scratchpadOn: Record<string, string> };

/** What a provider session lists: the tools as the fake bb host registered them. */
async function advertised(scratchpadEnabled: boolean) {
  const host = createFakePluginHost({ pluginId: "whiteboard", settings: { scratchpadEnabled } });
  // Registration runs no operation, so the engine is never called.
  await registerTools(host.bb, {} as Engine, createSettings(host.bb));
  return host.harness.registrations.agentTools;
}

const off = await advertised(false);
const on = await advertised(true);
const catalog: Golden = {
  tools: off.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  scratchpadOn: Object.fromEntries(
    on
      .filter((tool, index) => tool.description !== off[index]!.description)
      .map((tool) => [tool.name, tool.description]),
  ),
};
if (process.env.UPDATE_WHITEBOARD_GOLDEN)
  writeFileSync(GOLDEN, `${JSON.stringify(catalog, null, 2)}\n`);

test("bb advertises the golden catalog", () => {
  expect(catalog).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
});

test("28 tools in a fixed order, with names bb and providers accept", () => {
  const names = off.map((tool) => tool.name);
  expect(names).toEqual([
    "whiteboard_session_get_instructions",
    "whiteboard_status",
    "whiteboard_session_capabilities",
    "whiteboard_session_activity",
    "whiteboard_session_delete",
    "whiteboard_session_attention",
    "whiteboard_session_create",
    "whiteboard_session_set_target",
    "whiteboard_session_edit",
    "whiteboard_session_lens_edit",
    "whiteboard_session_rename",
    "whiteboard_session_repin",
    "whiteboard_session_restore",
    "whiteboard_session_list",
    "whiteboard_session_get",
    "whiteboard_session_lens_get",
    "whiteboard_session_history",
    "whiteboard_session_open",
    "whiteboard_session_environment",
    "whiteboard_session_workspace_cleanup",
    "whiteboard_session_register_repository",
    "whiteboard_session_resolve_pins",
    "whiteboard_session_upload",
    "whiteboard_session_source",
    "whiteboard_session_file",
    "whiteboard_session_tree",
    "whiteboard_session_diff",
    "whiteboard_session_commits",
  ]);
  // Claude Code sees bb tools as mcp__bb-bridge__<name>; providers cap names at 64.
  expect(names.filter((name) => `mcp__bb-bridge__${name}`.length > 64)).toEqual([]);
  expect(on.map((tool) => tool.name)).toEqual(names);
});

test("each description is its instructions/tools file", () => {
  expect(off.map((tool) => tool.description)).toEqual(
    off.map((tool) => files.tool(tool.name).description),
  );
});

test("the scratchpad setting appends its guidance to get_instructions and changes nothing else", () => {
  expect(catalog.scratchpadOn).toEqual({
    whiteboard_session_get_instructions: `${files.tool("whiteboard_session_get_instructions").description}\n\n${files.read("get-instructions-scratchpad")}`,
  });
  expect(on.map((tool) => tool.inputSchema)).toEqual(off.map((tool) => tool.inputSchema));
});

test("no advertised text uses the Review vocabulary, except the review-source: link scheme", () => {
  const text = JSON.stringify([...off, ...on].map((tool) => [tool.description, tool.inputSchema]));
  const leftovers = text.replaceAll("review-source:", "").match(/review_\w+|reviewId|\bReview\b/g);
  expect(leftovers).toBeNull();
});

test("no tool adds thread instructions", () => {
  expect(off.map((tool) => tool.instructions)).toEqual(off.map(() => null));
});
