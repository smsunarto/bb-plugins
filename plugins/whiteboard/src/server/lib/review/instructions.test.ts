import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../sqlite-testing.ts";
import { createReviewApi } from "./api.ts";
import { INSTRUCTION_TOPICS, renderInstructions } from "./instructions.ts";
import { LocalReviewData } from "./local-data.ts";
import { ReviewStore } from "./store.ts";

const live = {
  desktopAvailable: true,
  scratchpadEnabled: true,
};

describe("renderInstructions", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "review-instructions-"));
    await mkdir(path.join(root, "instructions"));
    await Promise.all(
      Object.entries({
        authoring: "AUTHORING_WORKFLOW",
        "file-lenses": "LENS_GUIDANCE",
        scratchpad: "SCRATCHPAD_GUIDANCE",
      }).map(([name, content]) =>
        writeFile(path.join(root, "instructions", `${name}.md`), content),
      ),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("loads every packaged topic as standalone guidance", async () => {
    for (const topic of INSTRUCTION_TOPICS) {
      const guidance = await renderInstructions(topic, live);

      expect(guidance.trim().length).toBeGreaterThan(0);
      expect(guidance.trimStart().startsWith("---")).toBe(false);
      expect(guidance).not.toMatch(/\]\((?!https?:\/\/|review-source:|#)[^)]+\.md(?:#[^)]*)?\)/);
    }
  });

  it("serves the authoring workflow with the other topics listed", async () => {
    const authoring = await renderInstructions("authoring", live, root);

    expect(authoring.startsWith("AUTHORING_WORKFLOW")).toBe(true);
  });

  it("advertises the scratchpad only when Desktop has it enabled", async () => {
    expect(await renderInstructions("authoring", live, root)).toContain('topic:"scratchpad"');

    for (const context of [
      { ...live, scratchpadEnabled: false },
      { ...live, desktopAvailable: false },
    ]) {
      expect(await renderInstructions("authoring", context, root)).not.toContain(
        'topic:"scratchpad"',
      );
    }

    expect(
      await renderInstructions("scratchpad", { ...live, scratchpadEnabled: false }, root),
    ).not.toContain("SCRATCHPAD_GUIDANCE");
  });

  it("serves other fixed topics without Desktop", async () => {
    const context = { ...live, desktopAvailable: false };

    for (const [topic, marker] of [["file-lenses", "LENS_GUIDANCE"]] as const) {
      expect(await renderInstructions(topic, context, root)).toBe(marker);
    }
  });
});

describe("the instructions operation", () => {
  const stores: ReviewStore[] = [];

  afterEach(async () => {
    for (const store of stores) await store.close();
    stores.length = 0;
  });

  const api = (deps: Omit<Parameters<typeof createReviewApi>[0], "store" | "data"> = {}) => {
    const store = new ReviewStore(":memory:", {
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    });
    stores.push(store);
    return createReviewApi({ store, data: new LocalReviewData(store), ...deps });
  };

  it("serves the authoring workflow by default and each named topic", async () => {
    const reviews = api();
    const guidance = await reviews.instructions({});

    expect(guidance).toBe(
      await renderInstructions("authoring", { desktopAvailable: false, scratchpadEnabled: false }),
    );
    expect(await reviews.instructions({ topic: "authoring" })).toBe(guidance);
    expect(await reviews.instructions({ topic: "file-lenses" })).toBe(
      await renderInstructions("file-lenses", {
        desktopAvailable: false,
        scratchpadEnabled: false,
      }),
    );
  });

  it("serves every topic without querying renderer capabilities", async () => {
    const reviews = api({
      open: async () => ({ softwareMapEnabled: false }),
      capabilities: async () => {
        throw new Error("renderer unavailable");
      },
      scratchpadEnabled: () => true,
    });

    for (const topic of INSTRUCTION_TOPICS)
      expect((await reviews.instructions({ topic })).length).toBeGreaterThan(0);
    expect(await reviews.instructions({ topic: "scratchpad" })).toContain("# Scratchpad");
    expect(await reviews.instructions({})).toContain('topic:"scratchpad"');
  });

  it("offers the scratchpad only where a thread can show it and the setting is on", async () => {
    for (const [open, scratchpadEnabled, expected] of [
      [true, true, true],
      [false, true, false],
      [true, false, false],
    ] as const) {
      const reviews = api({
        open: open ? async () => ({ softwareMapEnabled: false }) : undefined,
        scratchpadEnabled: () => scratchpadEnabled,
      });

      expect((await reviews.instructions({})).includes('topic:"scratchpad"')).toBe(expected);
    }
  });
});
