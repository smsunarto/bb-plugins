import { mkdtemp, readFile as readDiskFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { files } from "../instructions.ts";
import { renameToolTokens } from "../tools/rename.ts";
import { INSTRUCTIONS } from "../vendor/generated/instructions.ts";
import { renderInstructions } from "../vendor/review/src/review-api/instructions.ts";
import { readFile } from "./embedded-fs.ts";

test("unchanged topics stay embedded across native path separators", async () => {
  expect(await readFile("/whiteboard/instructions/scratchpad.md", "utf8")).toBe(
    INSTRUCTIONS.scratchpad,
  );
  expect(await readFile("\\whiteboard\\instructions\\scratchpad.md")).toBe(INSTRUCTIONS.scratchpad);
});

test("any other path under the virtual root is a missing file", async () => {
  for (const path of [
    "/whiteboard/instructions/nope.md",
    "/whiteboard/instructions/authoring.md",
    "/whiteboard/instructions/file-lenses.md",
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
  expect(Object.keys(INSTRUCTIONS).sort()).toEqual(["scratchpad", "trace-archaeology"]);
  for (const topic of Object.keys(INSTRUCTIONS)) {
    const markdown = await upstreamMarkdown(topic);
    expect(INSTRUCTIONS[topic as keyof typeof INSTRUCTIONS]).toBe(renameToolTokens(markdown));
  }
});

describe("renderInstructions on the engine's virtual root", () => {
  const on = { desktopAvailable: true, scratchpadEnabled: true, traceEnabled: false };
  const off = { desktopAvailable: true, scratchpadEnabled: false, traceEnabled: false };

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
    expect(await renderInstructions("scratchpad", on)).toBe(INSTRUCTIONS.scratchpad);
  });

  test("gated topics answer their bb-adapted off messages", async () => {
    expect(await renderInstructions("scratchpad", off)).toBe(
      "The Whiteboard scratchpad is turned off. Answer in chat; the scratchpad can be turned on in the Whiteboard plugin settings in bb.",
    );
    expect(await renderInstructions("trace-archaeology", on)).toBe(
      "Trace capture is off in this bb plugin, so no agent traces are available. Uploaded trace quotes are supported.",
    );
  });
});
