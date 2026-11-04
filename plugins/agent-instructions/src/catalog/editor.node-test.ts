import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host.ts";
import plugin from "../server/server.ts";
import type { CatalogListing, ChangeResult } from "./contract.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(async () => {
    spawnSync("chmod", ["-R", "u+w", dir]); // published trees are read-only
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const skillMd = (name: string, body = "") =>
  `---\nname: ${name}\ndescription: The ${name} skill.\n---\n${body}`;

/** A dotfiles checkout with two skills, global text, and a Codex rule. */
async function dotfiles() {
  const root = await tempDir("editor-src-");
  const files: Record<string, string> = {
    "instructions/shared.md": "Shared text.\n",
    "instructions/codex.md": "Codex text.\n",
    "skills/probe/SKILL.md": skillMd("probe"),
    "skills/dev/SKILL.md": skillMd("dev", "See [probe](../probe/SKILL.md).\n"),
  };
  const write = async (path: string, content: string) => {
    const full = join(root, ".dotfiles/.agents", path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  };
  for (const [path, content] of Object.entries(files)) await write(path, content);
  return { root, write };
}

async function setup() {
  const machine = experimental_createHostEntryHarness(hostEntry);
  cleanup.push(() => machine.experimental_dispose());
  const dataDir = await tempDir("editor-data-");
  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-instructions",
    dataDir,
    experimental_callHostRpc: (call) =>
      machine.experimental_call(
        call.method as "readText",
        call.input as { rootPath: string; path: string },
      ),
    sdk: {
      projects: {
        list: async () => [
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
        list: async () => ({
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
        }),
      },
    },
  });
  await plugin(bb);
  cleanup.push(() => harness.lifecycle.dispose());
  const rpc = harness.behavior.callRpc.bind(harness.behavior);
  const change = (input: Record<string, unknown>) =>
    rpc("changeCatalog", input) as Promise<ChangeResult & { published?: { ok: boolean } }>;
  const listing = () => rpc("catalog", null) as Promise<CatalogListing>;
  const file = (input: { skill: string; path: string } | { doc: string }) =>
    rpc("catalogFile", input) as Promise<{ content: string | null; sha256: string | null }>;
  const importFrom = async (root: string) => {
    const result = await harness.behavior.runCli([
      "import",
      "--root",
      root,
      "--host",
      "host",
      "--apply",
    ]);
    assert.equal(result.exitCode, 0, result.stdout);
    return result.stdout;
  };
  const cli = (...args: string[]) => harness.behavior.runCli(args);
  return { dataDir, rpc, change, listing, file, importFrom, cli };
}

test("a save is stored and published; a stale or invalid save changes nothing", async () => {
  const { dataDir, change, listing, file } = await setup();
  const created = await change({
    op: "createSkill",
    name: "notes",
    description: "Take notes: carefully, # always",
  });
  assert.equal(created.outcome, "saved", JSON.stringify(created));
  assert.match(await readFile(join(dataDir, "skills/notes/SKILL.md"), "utf8"), /# always/);

  const saved = await change({
    op: "saveFile",
    skill: "notes",
    path: "references/a.md",
    content: "A\n",
    expectedSha256: null,
  });
  assert.equal(saved.outcome, "saved");
  assert.equal(saved.outcome === "saved" && saved.published?.ok, true);
  assert.equal(await readFile(join(dataDir, "skills/notes/references/a.md"), "utf8"), "A\n");
  assert.equal(
    saved.outcome === "saved" && saved.sha256,
    (await file({ skill: "notes", path: "references/a.md" })).sha256,
  );

  const revision = (await listing()).revision;
  const stale = await change({
    op: "saveFile",
    skill: "notes",
    path: "references/a.md",
    content: "B\n",
    expectedSha256: null,
  });
  assert.equal(stale.outcome, "conflict");
  const { sha256 } = await file({ skill: "notes", path: "SKILL.md" });
  const renamed = await change({
    op: "saveFile",
    skill: "notes",
    path: "SKILL.md",
    content: skillMd("other"),
    expectedSha256: sha256,
  });
  assert.equal(renamed.outcome, "invalid");
  assert.equal((await listing()).revision, revision);
});

test("paths that cannot exist together are refused, and #! scripts are executable", async () => {
  const { dataDir, change } = await setup();
  await change({ op: "createSkill", name: "notes", description: "Notes." });
  const save = (path: string, content = "x\n") =>
    change({ op: "saveFile", skill: "notes", path, content, expectedSha256: null });
  assert.equal((await save("references/a.md")).outcome, "saved");
  assert.equal((await save("references")).outcome, "invalid");
  assert.equal((await save("Skill.md")).outcome, "invalid");
  assert.equal((await save("../escape.md")).outcome, "invalid");
  assert.equal((await save("scripts/run.sh", "#!/bin/sh\necho ok\n")).outcome, "saved");
  assert.equal((await stat(join(dataDir, "skills/notes/scripts/run.sh"))).mode & 0o111, 0o111);
});

test("a name bb already delivers cannot be used for a new skill", async () => {
  const { change } = await setup();
  const result = await change({ op: "createSkill", name: "mcp", description: "Mine." });
  assert.equal(result.outcome, "invalid");
  assert.match(JSON.stringify(result), /hide the mcp skill from plugin bb-guide/);
});

test("deleting needs the version you saw; a deleted skill can be restored, and import skips it", async () => {
  const source = await dotfiles();
  const { dataDir, change, listing, importFrom } = await setup();
  await importFrom(source.root);
  const probe = (await listing()).skills.find((s) => s.name === "probe")!;

  const stale = await change({ op: "deleteSkill", name: "probe", expectedTreeSha: "0".repeat(64) });
  assert.equal(stale.outcome, "conflict");
  const deleted = await change({
    op: "deleteSkill",
    name: "probe",
    expectedTreeSha: probe.treeSha,
  });
  assert.equal(deleted.outcome, "saved");
  // dev links into probe, so its deletion warns.
  assert.match(JSON.stringify(deleted), /dev\/SKILL.md links into probe/);
  assert.equal(existsSync(join(dataDir, "skills/probe")), false);
  assert.deepEqual(
    (await listing()).deleted.map((d) => d.key),
    ["probe"],
  );

  assert.match(await importFrom(source.root), /probe was deleted in bb; restore it/);
  assert.equal(existsSync(join(dataDir, "skills/probe")), false);

  const restored = await change({ op: "restore", kind: "skill", key: "probe" });
  assert.equal(restored.outcome, "saved");
  assert.match(await readFile(join(dataDir, "skills/probe/SKILL.md"), "utf8"), /name: probe/);
  assert.deepEqual((await listing()).deleted, []);
});

test("an edit makes an imported skill, doc, or rule yours, and import keeps it", async () => {
  const source = await dotfiles();
  const { rpc, change, listing, file, importFrom } = await setup();
  await importFrom(source.root);

  const dev = await file({ skill: "dev", path: "SKILL.md" });
  await change({
    op: "saveFile",
    skill: "dev",
    path: "SKILL.md",
    content: skillMd("dev", "Edited in bb.\n"),
    expectedSha256: dev.sha256,
  });
  const doc = (await listing()).docs[0]!;
  await change({ op: "saveDoc", id: doc.id, body: "Edited text.\n", expectedSha256: doc.sha256 });
  await change({ op: "setSkillEnabled", name: "probe", enabled: false });
  const rules = (await rpc("rules", null)) as {
    revision: number;
    rules: { id: string; instructions: string }[];
  };
  await rpc("saveRules", {
    revision: rules.revision,
    rules: rules.rules.map((r) =>
      Object.assign(structuredClone(r), { instructions: "Codex edited.\n" }),
    ),
  });

  await source.write("skills/dev/SKILL.md", skillMd("dev", "Changed in dotfiles.\n"));
  await source.write("instructions/shared.md", "Changed shared.\n");
  await source.write("instructions/codex.md", "Changed codex.\n");
  await source.write("skills/probe/SKILL.md", skillMd("probe", "New probe.\n"));
  const out = await importFrom(source.root);
  assert.match(out, /kept the version of dev edited in bb/);
  assert.match(out, /shared.md: kept the text edited in bb/);
  assert.match(out, /Kept as edited or deleted in bb: rule rule_import_codex/);

  assert.match((await file({ skill: "dev", path: "SKILL.md" })).content!, /Edited in bb/);
  assert.equal((await file({ doc: doc.id })).content, "Edited text.\n");
  const after = (await rpc("rules", null)) as { rules: { instructions: string }[] };
  assert.equal(after.rules[0]!.instructions, "Codex edited.\n");
  // Turning a skill off is not an edit: the import still refreshed probe, and kept it off.
  const probe = (await listing()).skills.find((s) => s.name === "probe")!;
  assert.deepEqual([probe.origin.kind, probe.enabled], ["imported", false]);
  assert.match((await file({ skill: "probe", path: "SKILL.md" })).content!, /New probe/);
});

test("docs can be created, renamed, turned off, and deleted, and AGENTS.md follows", async () => {
  const { dataDir, change, listing } = await setup();
  const created = await change({ op: "createDoc", name: "House rules" });
  assert.equal(created.outcome === "saved" && typeof created.id, "string");
  const id = created.outcome === "saved" ? created.id! : "";
  const saved = await change({
    op: "saveDoc",
    id,
    body: "Be kind.\n",
    expectedSha256: created.outcome === "saved" ? created.sha256 : "",
  });
  assert.equal(saved.outcome, "saved");
  assert.equal(await readFile(join(dataDir, "AGENTS.md"), "utf8"), "Be kind.\n");
  await change({ op: "renameDoc", id, name: "Kindness" });
  assert.equal((await listing()).docs[0]!.name, "Kindness");
  await change({ op: "setDocEnabled", id, enabled: false });
  assert.equal(existsSync(join(dataDir, "AGENTS.md")), false);
  const doc = (await listing()).docs[0]!;
  assert.equal(
    (await change({ op: "deleteDoc", id, expectedSha256: doc.sha256 })).outcome,
    "saved",
  );
  assert.deepEqual(
    (await listing()).deleted.map((d) => [d.kind, d.name]),
    [["doc", "Kindness"]],
  );
});

test("turning a rule off is not an edit, but narrowing its scope is, even once its source is gone", async () => {
  const source = await dotfiles();
  const { rpc, importFrom } = await setup();
  await importFrom(source.root);
  type Rules = {
    revision: number;
    rules: { id: string; enabled: boolean; instructions: string; when: { models: string[] } }[];
  };
  const update = async (change: (rule: Rules["rules"][number]) => object) => {
    const state = (await rpc("rules", null)) as Rules;
    await rpc("saveRules", {
      revision: state.revision,
      rules: state.rules.map((r) => Object.assign(structuredClone(r), change(r))),
    });
  };
  const codex = async () => ((await rpc("rules", null)) as Rules).rules[0]!;

  await update(() => ({ enabled: false }));
  await source.write("instructions/codex.md", "Codex v2.\n");
  await importFrom(source.root);
  assert.deepEqual([(await codex()).instructions, (await codex()).enabled], ["Codex v2.", false]);

  await update((r) => ({ when: { ...r.when, models: ["gpt-*"] } }));
  await source.write("instructions/codex.md", "Codex v3.\n");
  assert.match(await importFrom(source.root), /rule rule_import_codex: kept the rule edited in bb/);
  assert.equal((await codex()).instructions, "Codex v2.");

  // Without --prune, a missing source would stop the import; an edited rule does not.
  await rm(join(source.root, ".dotfiles/.agents/instructions/codex.md"));
  await importFrom(source.root);
  assert.deepEqual((await codex()).when.models, ["gpt-*"]);
});

test("agents edit skills through the CLI, and a stale --expect changes nothing", async () => {
  const { dataDir, listing, cli } = await setup();
  const created = await cli("skill", "create", "notes", "--description", "Take notes.");
  assert.equal(created.exitCode, 0, created.stderr);
  const createdSha =
    /^notes\/SKILL.md: saved as revision \d+, sha256 ([0-9a-f]{64}), tree sha256 [0-9a-f]{64}\n/.exec(
      created.stdout,
    )?.[1];

  const shown = await cli("skill", "show", "notes");
  assert.equal(shown.exitCode, 0, shown.stderr);
  assert.match(shown.stdout, /^---\nname: notes\n/);
  const sha = /SKILL.md: sha256 ([0-9a-f]{64})/.exec(shown.stderr)?.[1];
  assert.ok(sha, shown.stderr);
  assert.equal(createdSha, sha, "create prints the sha256 that write needs");

  // A file is stored byte for byte, final blank lines included.
  const body = skillMd("notes", "Write it down.\n\n");
  const draft = join(await tempDir("editor-draft-"), "SKILL.md");
  await writeFile(draft, body);
  const fromFile = (expect: string, ...rest: string[]) =>
    cli("skill", "write", "notes", "SKILL.md", "--file", draft, "--expect", expect, ...rest);
  assert.match((await fromFile(sha)).stderr, /--file needs --host outside a bb thread/);
  const written = await fromFile(sha, "--host", "host");
  assert.equal(written.exitCode, 0, written.stderr);
  assert.match(written.stdout, /Published for new threads/);
  assert.equal(await readFile(join(dataDir, "skills/notes/SKILL.md"), "utf8"), body);
  const missing = await cli(
    "skill",
    "write",
    "notes",
    "SKILL.md",
    "--file",
    `${draft}.gone`,
    "--host",
    "host",
    "--expect",
    sha,
  );
  assert.match(missing.stderr, /does not exist on host host/);
  const both = await cli("skill", "write", "notes", "SKILL.md", "--expect", sha);
  assert.match(both.stderr, /exactly one of --file or --content/);

  // Writing back what show printed adds no revision.
  const write = (content: string, expect: string) =>
    cli("skill", "write", "notes", "SKILL.md", "--content", content, "--expect", expect);

  const revision = (await listing()).revision;
  const newSha = /sha256 ([0-9a-f]{64})/.exec(written.stdout)?.[1] ?? "";
  assert.match((await write(body, newSha)).stdout, /unchanged; nothing saved/);
  const stale = await write(`${body}\nMore.`, sha);
  assert.notEqual(stale.exitCode, 0);
  assert.match(stale.stderr, /changed since you opened it/);
  const badSha = await write(body, "x");
  assert.notEqual(badSha.exitCode, 0);
  assert.match(badSha.stderr, /64-character sha256/);
  assert.equal((await listing()).revision, revision);

  const added = await cli(
    "skill",
    "write",
    "notes",
    "references/a.md",
    "--content",
    "A",
    "--expect",
    "new",
  );
  assert.equal(added.exitCode, 0, added.stderr);
  const json = JSON.parse(
    (await cli("skill", "show", "notes", "references/a.md", "--json")).stdout,
  );
  assert.deepEqual([json.content, json.files], ["A", ["SKILL.md", "references/a.md"]]);

  const removed = await cli("skill", "delete", "notes", "references/a.md", "--expect", json.sha256);
  assert.equal(removed.exitCode, 0, removed.stderr);
  assert.equal(existsSync(join(dataDir, "skills/notes/references/a.md")), false);
  const tree = (await listing()).skills.find((s) => s.name === "notes")!.treeSha;
  assert.match((await cli("skill", "delete", "nots", "--expect", tree)).stderr, /No skill nots/);
  const gone = await cli("skill", "delete", "notes", "--expect", tree);
  assert.equal(gone.exitCode, 0, gone.stderr);
  assert.equal(existsSync(join(dataDir, "skills/notes")), false);
  assert.match((await cli("skill", "show", "notes")).stderr, /No skill notes/);
});

test("agents can delete a binary skill file through the CLI", async () => {
  const source = await dotfiles();
  const logo = join(source.root, ".dotfiles/.agents/skills/probe/assets/logo.png");
  await mkdir(dirname(logo), { recursive: true });
  await writeFile(logo, Buffer.from([0x89, 0x50, 0x00, 0xff]));
  const { dataDir, importFrom, cli } = await setup();
  await importFrom(source.root);

  const text = await cli("skill", "show", "probe", "assets/logo.png");
  assert.notEqual(text.exitCode, 0);
  assert.match(text.stderr, /not a text file[\s\S]*--json/);
  const json = JSON.parse(
    (await cli("skill", "show", "probe", "assets/logo.png", "--json")).stdout,
  );
  assert.equal(json.content, null);
  const removed = await cli("skill", "delete", "probe", "assets/logo.png", "--expect", json.sha256);
  assert.equal(removed.exitCode, 0, removed.stderr);
  assert.equal(existsSync(join(dataDir, "skills/probe/assets/logo.png")), false);
});

test("a CLI change that saves but does not publish exits 1", async () => {
  const { dataDir, listing, cli } = await setup();
  const created = await cli("skill", "create", "notes", "--description", "Take notes.");
  const sha = /sha256 ([0-9a-f]{64})/.exec(created.stdout)?.[1] ?? "";
  const skills = join(dataDir, "skills");
  spawnSync("chmod", ["a-w", skills]); // the published link cannot be replaced
  try {
    const revision = (await listing()).revision;
    const body = skillMd("notes", "Unpublished.");
    const written = await cli(
      "skill",
      "write",
      "notes",
      "SKILL.md",
      "--content",
      body,
      "--expect",
      sha,
    );
    assert.equal(written.exitCode, 1, written.stdout);
    assert.match(written.stdout, /saved as revision/);
    assert.match(written.stderr, /Saved, but not published[\s\S]*bb agent-instructions publish/);
    assert.equal((await listing()).revision, revision + 1);
  } finally {
    spawnSync("chmod", ["u+w", skills]);
  }
});

test("agents edit the global doc through the CLI", async () => {
  const source = await dotfiles();
  const { dataDir, listing, importFrom, cli } = await setup();
  await importFrom(source.root);
  const id = (await listing()).docs[0]!.id;

  const shown = await cli("doc", "show", id);
  assert.equal(shown.stdout, "Shared text.");
  const sha = /sha256 ([0-9a-f]{64})/.exec(shown.stderr)?.[1] ?? "";
  // An editor's final newline is not a change: docs are stored trimmed, as imported.
  const revision = (await listing()).revision;
  const same = await cli("doc", "write", id, "--content", "Shared text.\n", "--expect", sha);
  assert.match(same.stdout, /unchanged; nothing saved/);
  assert.equal((await listing()).revision, revision);

  const written = await cli("doc", "write", id, "--content", "New shared text.\n", "--expect", sha);
  assert.equal(written.exitCode, 0, written.stderr);
  assert.equal(await readFile(join(dataDir, "AGENTS.md"), "utf8"), "New shared text.\n");
  assert.notEqual((await cli("doc", "write", id, "--content", "x", "--expect", sha)).exitCode, 0);

  const current = JSON.parse((await cli("doc", "show", id, "--json")).stdout).sha256;
  assert.match((await cli("doc", "delete", "nope", "--expect", current)).stderr, /No doc nope/);
  assert.equal((await cli("doc", "delete", id, "--expect", current)).exitCode, 0);
  assert.equal(existsSync(join(dataDir, "AGENTS.md")), false);
  assert.deepEqual(
    (await listing()).deleted.map((d) => d.kind),
    ["doc"],
  );
});
