import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, test } from "vitest";
import { createSettings } from "../settings.ts";
import { flattenSchema } from "./flatten-schema.ts";
import { registerTools } from "./register.ts";
import { bbToolName, renameSchemaDescriptions, renameToolTokens } from "./rename.ts";
import { fakeEngine, loadGolden } from "./testing.ts";

const golden = loadGolden();

async function registered(scratchpadEnabled: boolean) {
  const host = createFakePluginHost({ pluginId: "whiteboard", settings: { scratchpadEnabled } });
  const { engine } = fakeEngine(() => new Response(null, { status: 500 }));
  await registerTools(host.bb, engine, createSettings(host.bb));
  return host.harness.inspection.registrations.agentTools;
}

describe.each([
  ["off", false, golden.scratchpadOff.tools],
  ["on", true, golden.scratchpadOn.tools],
] as const)("with the scratchpad %s, bb advertises upstream's MCP catalog", (_label, on, tools) => {
  test("28 tools, in upstream's listing order, with bb names", async () => {
    const names = (await registered(on)).map((tool) => tool.name);
    expect(names).toHaveLength(28);
    expect(names).toEqual(tools.map((tool) => bbToolName(tool.name)));
  });

  test("descriptions are upstream's text with session_x tokens renamed", async () => {
    // The golden get_instructions description already carries the
    // mcpAuthoringGuidance prefix, as upstream's ListTools sends it.
    const descriptions = (await registered(on)).map((tool) => tool.description);
    expect(descriptions).toEqual(tools.map((tool) => renameToolTokens(tool.description)));
  });

  test("schemas are upstream's, flattened, with schema prose renamed", async () => {
    const schemas = (await registered(on)).map((tool) => tool.inputSchema);
    expect(schemas).toEqual(
      tools.map((tool) => renameSchemaDescriptions(flattenSchema(tool.inputSchema))),
    );
  });

  test("no tool contributes thread instructions", async () => {
    expect((await registered(on)).map((tool) => tool.instructions)).toEqual(tools.map(() => null));
  });
});

test("the get_instructions description is the guidance, a blank line, then the catalog text", async () => {
  const [off] = await registered(false);
  expect(off!.name).toBe("whiteboard_session_get_instructions");
  expect(off!.description).toBe(
    'Whiteboard explains code in documents the user reads in Whiteboard Desktop. Call whiteboard_session_get_instructions before creating or editing a Whiteboard and follow it. Read whiteboard_session_capabilities before authoring; whiteboard_session_create opens the new review in Desktop when it is available, so call whiteboard_session_open only for an existing review, and generate software maps only when softwareMapEnabled is true. When the user asks for a Whiteboard or to use Whiteboard (for example to review a branch, a change or a pull request, or to explain a system in Whiteboard), author a Whiteboard with the default topic. When the user asks in conversation to be shown how code works or wants a diagram, without asking for a Whiteboard, call whiteboard_session_capabilities; if it reports scratchpadEnabled and desktopAvailable, draw on the Whiteboard scratchpad rather than answering only in chat, starting with whiteboard_session_get_instructions({topic:"scratchpad"}). Never read or write Whiteboard files or SQL. Reuse commandId and identical input after a lost response.\n\nRead Whiteboard\'s guidance before creating or editing a Whiteboard. The default topic gives the authoring workflow; "file-lenses" covers Diff-view file lenses.',
  );
  const [on] = await registered(true);
  expect(on!.description).toBe(
    `${off!.description} When the user asks in conversation to be shown how code works or wants a diagram, without asking for a Whiteboard, draw it on the Whiteboard scratchpad rather than answering only in chat: call whiteboard_session_get_instructions({topic:"scratchpad"}) first. A request for a Whiteboard or to use Whiteboard means authoring a Whiteboard with the default topic.`,
  );
});

test("the scratchpad setting changes the get_instructions description and nothing else", async () => {
  const off = await registered(false);
  const on = await registered(true);
  const differing = off
    .map((tool, index) => [tool, on[index]!] as const)
    .filter(
      ([a, b]) =>
        JSON.stringify(a.inputSchema) !== JSON.stringify(b.inputSchema) ||
        a.description !== b.description,
    )
    .map(([tool]) => tool.name);
  expect(differing).toEqual(["whiteboard_session_get_instructions"]);
});

test("only session_edit and session_upload schemas differ from upstream", async () => {
  const tools = await registered(false);
  const changed = golden.scratchpadOff.tools
    .filter((tool, index) => {
      const upstream = renameSchemaDescriptions(tool.inputSchema);
      return JSON.stringify(upstream) !== JSON.stringify(tools[index]!.inputSchema);
    })
    .map((tool) => tool.name);
  expect(changed).toEqual(["session_edit", "session_upload"]);
});

test("the published text names bb tools only (no bare session_x token is left)", async () => {
  const text = JSON.stringify(
    (await registered(true)).map((tool) => [tool.description, tool.inputSchema]),
  );
  expect(text.match(/(?<!whiteboard_)\bsession_[a-z_]+\b/g)).toBeNull();
  // upstream's review_* leaks stay verbatim (design §3.5); none is in the catalog text
  expect(text.match(/\breview_[a-z]/g)).toBeNull();
});
