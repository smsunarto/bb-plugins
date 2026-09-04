import { expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

import plugin from "../server/server.ts";
import { mentionProviders } from "../server/mentions.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const skillsRoot = join(root, "skills");

test("the plugin loads against the fake host and registers every mention provider", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  await plugin(bb);

  expect(harness.registrations.rpcMethods).toEqual([]);
  expect(harness.registrations.mentionProviders.map((provider) => provider.id)).toEqual(
    mentionProviders.map((provider) => provider.id),
  );
});

test("mention provider ids are unique and free of the wire separator", () => {
  const ids = mentionProviders.map((provider) => provider.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
});

test("the manifest declares the skills root that holds every composer command", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  expect(manifest.bb.skills).toEqual(["skills"]);
  expect(manifest.files).toContain("skills/");
});

test("each skill directory carries a SKILL.md whose frontmatter name matches the directory", async () => {
  const directories = (await readdir(skillsRoot)).sort();
  expect(directories).toEqual(["ship-it", "sync"]);
  for (const directory of directories) {
    const path = join(skillsRoot, directory, "SKILL.md");
    expect((await stat(path)).isFile()).toBe(true);
    const skill = await readFile(path, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(frontmatter, `${directory}/SKILL.md starts with frontmatter`).not.toBeNull();
    const fields = Object.fromEntries(
      (frontmatter?.[1] ?? "")
        .split("\n")
        .map((line) => line.split(/:\s(.*)/s))
        .map(([key, value]) => [key, value ?? ""]),
    );
    expect(fields.name).toBe(directory);
    expect(fields.description?.length ?? 0).toBeGreaterThan(40);
  }
});

test("both commands route GitButler repositories through the gitbutler skill", async () => {
  for (const directory of ["ship-it", "sync"]) {
    const skill = await readFile(join(skillsRoot, directory, "SKILL.md"), "utf8");
    expect(skill).toContain("`gitbutler` skill");
    expect(skill).toContain("but status");
  }
});
