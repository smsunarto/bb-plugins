import { describe, expect, test, vi } from "vitest";
import { blockSchema, checkReferences } from "../../shared/review/document.ts";
import { files } from "./instructions.ts";
import { renderInstructions } from "./review/instructions.ts";

test("every published component example passes the real document schema and reference checks", () => {
  const examples = [...files.read("components").matchAll(/```json\n([\s\S]*?)\n```/g)].map(
    (match) => blockSchema.parse(JSON.parse(match[1]!)),
  );
  expect(examples.map((example) => example.type)).toEqual([
    "section",
    "code_peek",
    "sequence",
    "flow_diagram",
    "call_stack_diff",
    "database_lens",
  ]);
  checkReferences(examples);
});

describe("renderInstructions on the engine's virtual root", () => {
  const on = { desktopAvailable: true, scratchpadEnabled: true };
  const off = { desktopAvailable: true, scratchpadEnabled: false };

  test("authoring includes the component reference and respects the scratchpad setting", async () => {
    const authoring = `${files.read("authoring")}\n\n${files.read("components")}`;
    expect(await renderInstructions("authoring", on)).toBe(
      `${authoring}\n\n## More guidance\n\n- Explaining code visually outside a review: \`whiteboard_session_get_instructions({topic:"scratchpad"})\``,
    );
    expect(await renderInstructions("authoring", off)).toBe(authoring);
  });

  test("a later prompt read observes edited instructions without a plugin reload", async () => {
    const original = files.read.bind(files);
    let revision = "first";
    const read = vi
      .spyOn(files, "read")
      .mockImplementation((name) => (name === "authoring" ? revision : original(name)));
    try {
      expect(await renderInstructions("authoring", off)).toContain("first");
      revision = "edited";
      expect(await renderInstructions("authoring", off)).toContain("edited");
    } finally {
      read.mockRestore();
    }
  });

  test("other topics are served whole", async () => {
    expect(await renderInstructions("file-lenses", off)).toBe(files.read("file-lenses"));
    expect(await renderInstructions("scratchpad", on)).toBe(files.read("scratchpad"));
  });

  test("the scratchpad topic answers an off message when the setting is off", async () => {
    expect(await renderInstructions("scratchpad", off)).toBe(
      "The Whiteboard scratchpad is turned off. Answer in chat; the scratchpad can be turned on in the Whiteboard plugin settings in bb.",
    );
  });
});
