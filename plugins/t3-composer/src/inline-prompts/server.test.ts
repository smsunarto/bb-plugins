import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { INLINE_PROMPT_PROVIDER_ID } from "./contract";
import { parseInlinePrompt } from "./server";

const ABSTRACT = `---
name: abstract
description: "Shorthand for abstract thinking."
disable-model-invocation: true
inline: true
---

# Abstract

Exercise abstract thinking.
`;

const SKILL = `---
name: dev
description: Engineering workflow.
---

Read the principles.
`;

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "t3-inline-prompts-"));
  const skills = path.join(dataDir, "skills");
  await mkdir(path.join(skills, "dev"), { recursive: true });
  await writeFile(path.join(skills, "dev", "SKILL.md"), SKILL);
  // bb links each user-tier skill to its published tree.
  const tree = path.join(dataDir, "trees", "abstract");
  await mkdir(tree, { recursive: true });
  await writeFile(path.join(tree, "SKILL.md"), ABSTRACT);
  await symlink(tree, path.join(skills, "abstract"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "t3-composer", dataDir });
  await plugin(bb);
  const provider = harness.registrations.mentionProviders.find(
    (record) => record.id === INLINE_PROMPT_PROVIDER_ID,
  );
  if (!provider) throw new Error("inline prompt provider is not registered");
  return { harness, provider };
}

describe("inline prompts", () => {
  it("lists only skills marked inline", async () => {
    const { harness } = await host();
    expect(await harness.behavior.callRpc("inlinePrompts", null)).toEqual({ names: ["abstract"] });
  });

  it("resolves a pill to the skill's body without its frontmatter", async () => {
    const { provider } = await host();
    expect(await provider.resolve("abstract")).toEqual({
      context: "# Abstract\n\nExercise abstract thinking.",
    });
  });

  it("refuses skills that are not inline and names outside the skills directory", async () => {
    const { provider } = await host();
    await expect(provider.resolve("dev")).rejects.toThrow(/no longer an inline prompt/u);
    await expect(provider.resolve("../trees/abstract")).rejects.toThrow(
      /no longer an inline prompt/u,
    );
  });

  it("leaves the @ menu unchanged", async () => {
    const { provider } = await host();
    expect(
      await provider.search({ trigger: "@", query: "abs", projectId: null, threadId: null }),
    ).toEqual([]);
  });

  it("lists nothing when bb has no user-tier skills", async () => {
    await rm(path.join(dataDir, "skills"), { recursive: true });
    const { harness } = await host();
    expect(await harness.behavior.callRpc("inlinePrompts", null)).toEqual({ names: [] });
  });
});

describe("parseInlinePrompt", () => {
  it("needs `inline: true` in the frontmatter, not the body", () => {
    expect(parseInlinePrompt("---\nname: x\n---\ninline: true\n")).toBeNull();
    expect(parseInlinePrompt("---\nname: x\ninline: false\n---\nBody\n")).toBeNull();
    expect(parseInlinePrompt("---\r\nname: x\r\ninline: true\r\n---\r\nBody\r\n")).toBe("Body");
  });

  it("skips an inline skill with an empty body", () => {
    expect(parseInlinePrompt("---\ninline: true\n---\n\n")).toBeNull();
  });
});
