import { mkdtemp, readFile as readDiskFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { renameToolTokens } from "../tools/rename.ts";
import { INSTRUCTIONS } from "../vendor/generated/instructions.ts";
import { renderInstructions } from "../vendor/review/src/review-api/instructions.ts";
import { readFile } from "./embedded-fs.ts";

test("instruction topics are served from the generated module", async () => {
  expect(await readFile("/whiteboard/instructions/scratchpad.md", "utf8")).toBe(
    INSTRUCTIONS.scratchpad,
  );
  expect(await readFile("\\whiteboard\\instructions\\file-lenses.md")).toBe(
    INSTRUCTIONS["file-lenses"],
  );
});

test("any other path under the virtual root is a missing file", async () => {
  for (const path of [
    "/whiteboard/instructions/nope.md",
    "/whiteboard/instructions/toString.md",
    "/whiteboard/package.json",
  ]) {
    await expect(readFile(path)).rejects.toMatchObject({
      code: "ENOENT",
      message: `ENOENT: no such file or directory, open '${path}'`,
    });
  }
});

test("paths outside the virtual root read the disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wp3-embedded-fs-"));
  await writeFile(join(dir, "a.md"), "on disk");
  expect(await readFile(join(dir, "a.md"), "utf8")).toBe("on disk");
});

const upstreamMarkdown = (topic: string) =>
  readDiskFile(new URL(`../vendor/review/instructions/${topic}.md`, import.meta.url), "utf8");

test("each embedded topic is upstream's markdown with catalog session_x tokens renamed", async () => {
  expect(Object.keys(INSTRUCTIONS).sort()).toEqual([
    "authoring",
    "file-lenses",
    "scratchpad",
    "trace-archaeology",
  ]);
  for (const topic of Object.keys(INSTRUCTIONS)) {
    const markdown = await upstreamMarkdown(topic);
    expect(INSTRUCTIONS[topic as keyof typeof INSTRUCTIONS]).toBe(renameToolTokens(markdown));
  }
  // The rename is real: upstream names session_get_instructions, the embedded text names the bb tool.
  expect(await upstreamMarkdown("authoring")).toContain("`session_get_instructions({topic:");
  expect(INSTRUCTIONS.authoring).toContain("`whiteboard_session_get_instructions({topic:");
});

describe("renderInstructions on the engine's virtual root", () => {
  const on = { desktopAvailable: true, scratchpadEnabled: true, traceEnabled: false };
  const off = { desktopAvailable: true, scratchpadEnabled: false, traceEnabled: false };

  test("authoring is the embedded text plus upstream's scratchpad pointer", async () => {
    expect(await renderInstructions("authoring", on)).toBe(
      `${INSTRUCTIONS.authoring}\n\n## More guidance\n\n- Explaining code visually outside a review: \`whiteboard_session_get_instructions({topic:"scratchpad"})\``,
    );
    expect(await renderInstructions("authoring", off)).toBe(INSTRUCTIONS.authoring);
  });

  test("other topics are served whole", async () => {
    expect(await renderInstructions("file-lenses", off)).toBe(INSTRUCTIONS["file-lenses"]);
    expect(await renderInstructions("scratchpad", on)).toBe(INSTRUCTIONS.scratchpad);
  });

  test("gated topics answer upstream's off messages", async () => {
    expect(await renderInstructions("scratchpad", off)).toBe(
      "The Whiteboard scratchpad is turned off or Whiteboard Desktop is not running. Answer in chat; the scratchpad can be turned on in the Whiteboard plugin settings in bb.",
    );
    expect(await renderInstructions("trace-archaeology", on)).toBe(
      "Trace capture is off on this machine, so no agent traces are available. It can be turned on in the Whiteboard plugin settings in bb under Experimental Features.",
    );
  });
});
