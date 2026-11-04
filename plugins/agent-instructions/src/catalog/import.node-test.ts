import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import hostEntry from "../host.ts";
import plugin from "../server/server.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const skill = (name: string, body = "") =>
  `---\nname: ${name}\ndescription: The ${name} skill.\n---\n${body}`;

/** A dotfiles checkout in the shape the importer reads. */
async function fixture(extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "catalog-import-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const agents = join(root, ".dotfiles/.agents");
  const files: Record<string, string | Buffer> = {
    "instructions/shared.md":
      "Read `scott-engineering:dev` first.\nUse `scott-engineering:*` for Go.\n",
    "instructions/claude.md": "Claude-only rule.\n",
    "instructions/codex.md": "Codex-only rule.\n",
    "instructions/notes.md": "Not a provider.\n",
    "skills/probe/SKILL.md": skill("probe", "Run `scripts/run.sh`.\n"),
    "skills/probe/scripts/run.sh": "#!/bin/sh\necho ok\n",
    "skills/probe/assets/blob.bin": Buffer.from([0, 255, 1, 254, 2]),
    "plugins/scott-engineering/skills/dev/SKILL.md": skill(
      "dev",
      "See [grug](../principle-grug-brain/SKILL.md) and `scott-engineering:principle-grug-brain`.\n",
    ),
    "plugins/scott-engineering/skills/principle-grug-brain/SKILL.md": skill("principle-grug-brain"),
    "plugins/dotfiles/skills/mcp/SKILL.md": skill("mcp"),
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(agents, path)), { recursive: true });
    await writeFile(join(agents, path), content);
  }
  await chmod(join(agents, "skills/probe/scripts/run.sh"), 0o755);
  return { root, agents };
}

async function setup({ skillsFail = false } = {}) {
  const machine = experimental_createHostEntryHarness(hostEntry);
  cleanup.push(() => machine.experimental_dispose());
  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-instructions",
    experimental_callHostRpc: (call) =>
      machine.experimental_call(
        call.method as "readText",
        call.input as { rootPath: string; path: string },
      ),
    sdk: {
      projects: {
        // Like bb, the personal project is listed only when asked for.
        list: async (args?: { includePersonal?: boolean }) =>
          !args?.includePersonal
            ? []
            : [
                {
                  id: "proj_personal",
                  name: "Personal",
                  kind: "personal",
                  gitRemoteUrl: null,
                  createdAt: 1,
                  updatedAt: 1,
                  sources: [],
                },
              ],
      },
      skills: {
        list: async () => {
          if (skillsFail) throw new Error("skills offline");
          return {
            skills: [
              {
                id: "s1",
                name: "mcp",
                description: "bb's MCP guide",
                filePath: "/x/mcp/SKILL.md",
                manageable: false,
                pluginId: "bb-guide",
                provider: null,
                registrySkillId: null,
                scope: "plugin" as const,
              },
            ],
          };
        },
      },
    },
  });
  await plugin(bb);
  cleanup.push(() => harness.lifecycle.dispose());
  const run = async (...args: string[]) => {
    const result = await harness.behavior.runCli(args);
    return { ...result, json: result.stdout.startsWith("{") ? JSON.parse(result.stdout) : null };
  };
  return { run };
}

test("a dry run reports what would be imported and stores nothing", async () => {
  const { root } = await fixture();
  const { run } = await setup();
  const plan = await run("import", "--root", root, "--host", "host", "--json");
  assert.equal(plan.exitCode, 1);
  assert.deepEqual(plan.json.errors, [
    "dotfiles:mcp: would hide the mcp skill from plugin bb-guide; pass --rename dotfiles:mcp=<new-name>",
  ]);
  assert.ok(
    plan.json.warnings.includes(
      ".dotfiles/.agents/instructions/notes.md: no provider is known for this fragment; skipped",
    ),
  );
  assert.ok(
    plan.json.warnings.includes(
      "scott-engineering:* names a whole plugin; flat skill names have no equivalent, so rewrite that sentence",
    ),
  );
  assert.equal((await run("catalog")).stdout, "The catalog is empty\n");
});

test("applying stores flattened skills, modes, global text, and provider rules once", async () => {
  const { root } = await fixture();
  const { run } = await setup();
  const args = [
    "import",
    "--root",
    root,
    "--host",
    "host",
    "--rename",
    "dotfiles:mcp=dotfiles-mcp",
    "--apply",
  ];
  const applied = await run(...args);
  assert.equal(applied.exitCode, 0, applied.stdout);
  assert.match(applied.stdout, /Renamed: dotfiles:mcp -> dotfiles-mcp/);
  assert.match(
    applied.stdout,
    /Stored revision 1: 4 added, 0 updated, 0 removed, 0 unchanged; docs 1; rules 2/,
  );

  const catalog = (await run("catalog", "--json")).json;
  assert.deepEqual(
    catalog.skills.map((s: { name: string }) => s.name),
    ["dev", "dotfiles-mcp", "principle-grug-brain", "probe"],
  );
  assert.equal(catalog.skills.find((s: { name: string }) => s.name === "probe").files, 3);
  assert.deepEqual(
    catalog.docs.map((d: { id: string; name: string; enabled: boolean }) => [
      d.id,
      d.name,
      d.enabled,
    ]),
    [["imported:shared", "Global instructions", true]],
  );

  const rules = (await run("list", "--json")).json.rules;
  assert.deepEqual(
    rules.map((r: { id: string; when: { providers: string[] } }) => [r.id, r.when.providers]),
    [
      ["rule_import_claude", ["claude-code"]],
      ["rule_import_codex", ["codex"]],
    ],
  );

  const again = await run(...args);
  assert.match(again.stdout, /Stored: nothing changed/);
  assert.equal((await run("catalog", "--json")).json.revision, 1);
});

test("skills that would break once published are refused", async () => {
  const { root, agents } = await fixture({
    "skills/statechart/SKILL.md": skill(
      "statechart",
      "Run `~/.agents/skills/statechart/scripts/statechart`.\n",
    ),
    "plugins/media/skills/remotion/SKILL.md": skill(
      "remotion",
      "Uses the [runtime](../../runtime/README.md).\n",
    ),
  });
  await symlink("SKILL.md", join(agents, "skills/probe/linked.md"));
  const { run } = await setup();
  const plan = await run("import", "--root", root, "--host", "host", "--allow-shadow", "--json");
  assert.equal(plan.exitCode, 1);
  assert.deepEqual(plan.json.errors, [
    "probe: contains links (linked.md); bb refuses linked files inside a skill",
    "statechart: SKILL.md: uses the install path ~/.agents/skills/statechart; refer to it relative to the skill",
    "media:remotion: SKILL.md: links outside the skill folder (../../runtime/README.md)",
  ]);
});

const importArgs = (root: string, ...more: string[]) => [
  "import",
  "--root",
  root,
  "--host",
  "host",
  "--rename",
  "dotfiles:mcp=dotfiles-mcp",
  ...more,
];

test("removing what the source dropped needs --prune, and then docs and rules stop too", async () => {
  const { root, agents } = await fixture();
  const { run } = await setup();
  assert.equal((await run(...importArgs(root, "--apply"))).exitCode, 0);
  await rm(join(agents, "skills/probe"), { recursive: true });
  await rm(join(agents, "instructions/shared.md"));
  await rm(join(agents, "instructions/claude.md"));

  const refused = await run(...importArgs(root, "--apply", "--json"));
  assert.equal(refused.exitCode, 1);
  assert.deepEqual(refused.json.errors, [
    "The source no longer has skill probe, doc imported:shared, rule rule_import_claude; pass --prune to remove them, or check --root",
  ]);
  assert.equal((await run("catalog", "--json")).json.revision, 1);

  const pruned = await run(...importArgs(root, "--apply", "--prune"));
  assert.equal(pruned.exitCode, 0, pruned.stdout);
  assert.match(
    pruned.stdout,
    /Stored revision 2: 0 added, 0 updated, 1 removed, 3 unchanged; docs 1; rules 1/,
  );
  const catalog = (await run("catalog", "--json")).json;
  assert.deepEqual(catalog.docs, []);
  assert.ok(!catalog.skills.some((s: { name: string }) => s.name === "probe"));
  const rules = (await run("list", "--json")).json.rules;
  assert.deepEqual(
    rules.map((r: { id: string }) => r.id),
    ["rule_import_codex"],
  );
});

test("links on the way to a source are reported, never followed", async () => {
  const { root, agents } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "catalog-outside-"));
  cleanup.push(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(outside, "evil"));
  await writeFile(join(outside, "evil/SKILL.md"), skill("evil"));
  await symlink(join(outside, "evil"), join(agents, "skills/evil"));
  await symlink("shared.md", join(agents, "instructions/linked.md"));
  await symlink(outside, join(agents, "plugins/elsewhere"));
  const { run } = await setup();
  const plan = await run(...importArgs(root, "--json"));
  assert.equal(plan.exitCode, 1);
  assert.deepEqual(plan.json.errors.filter((e: string) => e.includes("is a link")).sort(), [
    ".dotfiles/.agents/instructions/linked.md: is a link; the importer does not follow links, so replace it with the real folder or file",
    ".dotfiles/.agents/plugins/elsewhere: is a link; the importer does not follow links, so replace it with the real folder or file",
    ".dotfiles/.agents/skills/evil: is a link; the importer does not follow links, so replace it with the real folder or file",
  ]);
  assert.ok(!plan.json.skills.some((s: { name: string }) => s.name === "evil"));

  const linkedRoot = await mkdtemp(join(tmpdir(), "catalog-linked-"));
  cleanup.push(() => rm(linkedRoot, { recursive: true, force: true }));
  await symlink(join(root, ".dotfiles"), join(linkedRoot, ".dotfiles"));
  const refused = await run("import", "--root", linkedRoot, "--host", "host");
  assert.notEqual(refused.exitCode, 0);
  assert.match(`${refused.stdout}${refused.stderr ?? ""}`, /\.dotfiles is a link/);
});

test("a rename it cannot write, or a shadow check that cannot run, stops the import", async () => {
  const { root } = await fixture({
    "plugins/dotfiles/skills/mcp/SKILL.md":
      "---\nname: mcp # bb has one too\ndescription: d\n---\n",
  });
  const { run } = await setup();
  const plan = await run(...importArgs(root, "--json"));
  assert.deepEqual(plan.json.errors, [
    "dotfiles:mcp: SKILL.md still declares mcp; the rename could not rewrite it, so set name: dotfiles-mcp by hand",
  ]);

  const offline = await setup({ skillsFail: true });
  const blind = await offline.run(...importArgs(root, "--json"));
  assert.ok(
    blind.json.errors.includes(
      "Could not check for skills bb already delivers (skills offline); pass --allow-shadow to import without the check",
    ),
  );
  const allowed = await offline.run(...importArgs(root, "--allow-shadow", "--json"));
  assert.ok(!allowed.json.errors.some((e: string) => e.startsWith("Could not check")));
});
