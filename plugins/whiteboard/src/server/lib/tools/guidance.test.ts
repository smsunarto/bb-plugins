import { stripTypeScriptTypes } from "node:module";
import { expect, test } from "vitest";
import { mcpAuthoringGuidance } from "./guidance.ts";
import { loadGolden } from "./testing.ts";

type Guidance = typeof mcpAuthoringGuidance;

/** Upstream's `mcpAuthoringGuidance`, captured from `mcp.ts` in the golden, run as written. */
const upstream = new Function(
  `${stripTypeScriptTypes(loadGolden().guidanceSource)}\nreturn mcpAuthoringGuidance;`,
)() as Guidance;

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "scratchpadAvailable %s, traceEnabled %s matches upstream",
  (scratchpadAvailable, traceEnabled) => {
    const context = { scratchpadAvailable, traceEnabled };
    expect(mcpAuthoringGuidance(context)).toBe(upstream(context));
  },
);

test("the guidance the catalog uses is the first, scratchpad and last sentences", () => {
  expect(mcpAuthoringGuidance({ scratchpadAvailable: true, traceEnabled: false })).toBe(
    'Whiteboard explains code in documents the user reads in Whiteboard Desktop. Call session_get_instructions before creating or editing a Whiteboard and follow it. Read session_capabilities before authoring; session_create opens the new review in Desktop when it is available, so call session_open only for an existing review, and generate software maps only when softwareMapEnabled is true. When the user asks for a Whiteboard or to use Whiteboard (for example to review a branch, a change or a pull request, or to explain a system in Whiteboard), author a Whiteboard with the default topic. When the user asks in conversation to be shown how code works or wants a diagram, without asking for a Whiteboard, call session_capabilities; if it reports scratchpadEnabled and desktopAvailable, draw on the Whiteboard scratchpad rather than answering only in chat, starting with session_get_instructions({topic:"scratchpad"}). Never read or write Whiteboard files or SQL. Reuse commandId and identical input after a lost response.',
  );
});
