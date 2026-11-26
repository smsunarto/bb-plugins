import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
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

async function writeSourceFile(sourceDir: string, relPath: string, content: string | Uint8Array) {
  const full = join(sourceDir, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

async function setup() {
  const machine = experimental_createHostEntryHarness(hostEntry);
  cleanup.push(() => machine.experimental_dispose());
  const dataDir = await tempDir("editor-data-");
  const sourceDir = join(dataDir, "plugins/agent-instructions/source");
  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-instructions",
    dataDir,
    experimental_callHostRpc: (call) =>
      machine.experimental_call(call.method as never, call.input as never),
    sdk: {
      files: {
        read: async (req: { path: string }) => {
          const content = await readFile(req.path, "utf8");
          return {
            content,
            contentEncoding: "utf8",
            sizeBytes: Buffer.byteLength(content, "utf8"),
            sha256: "0".repeat(64),
          } as never;
        },
      } as never,
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
  const cli = (...args: string[]) => harness.behavior.runCli(args);
  return { dataDir, sourceDir, harness, rpc, change, listing, file, cli };
}

test("editing a doc, rule, or skill directly on disk reaches publishing and agent prompts without any CLI write", async () => {
  const { dataDir, sourceDir, harness, listing } = await setup();

  await writeSourceFile(sourceDir, "instructions/shared.md", "Direct disk doc.\n");
  await writeSourceFile(
    sourceDir,
    "rules/direct.md",
    "---\nname: Direct rule\nenabled: true\nwhen:\n  providers:\n    - codex\n---\n\nDirect disk rule.\n",
  );
  await writeSourceFile(
    sourceDir,
    "skills/disk-skill/SKILL.md",
    skillMd("disk-skill", "Edited directly on disk.\n"),
  );

  // Wait for fs.watch debounce + background publish.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      existsSync(join(dataDir, "AGENTS.md")) &&
      existsSync(join(dataDir, "skills/disk-skill/SKILL.md"))
    )
      break;
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.equal(await readFile(join(dataDir, "AGENTS.md"), "utf8"), "Direct disk doc.\n");
  assert.match(
    await readFile(join(dataDir, "skills/disk-skill/SKILL.md"), "utf8"),
    /Edited directly on disk/,
  );

  const resolved = await harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: "thr_disk" },
      host: { id: "host_1" },
      provider: { id: "codex", model: "gpt-5" },
      project: { id: "proj_personal" },
    }),
  );
  assert.equal(resolved.instructions, "Direct disk rule.");
  assert.equal((await listing()).docs[0]?.id, "shared");
});

test("a save is stored and published; a stale or invalid save changes nothing", async () => {
  const { dataDir, sourceDir, change, listing, file } = await setup();
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

  // External on-disk edit is caught by CAS before overwriting!
  const beforeDiskEdit = (await file({ skill: "notes", path: "references/a.md" })).sha256;
  await writeSourceFile(sourceDir, "skills/notes/references/a.md", "Edited on disk.\n");
  const conflictResult = await change({
    op: "saveFile",
    skill: "notes",
    path: "references/a.md",
    content: "UI stale save.\n",
    expectedSha256: beforeDiskEdit,
  });
  assert.equal(conflictResult.outcome, "conflict");
  assert.equal(
    await readFile(join(sourceDir, "skills/notes/references/a.md"), "utf8"),
    "Edited on disk.\n",
  );

  const revision = (await listing()).revision;
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
  assert.equal((await save(".disabled")).outcome, "invalid");
  assert.equal((await save(".DS_Store")).outcome, "invalid");
  assert.equal((await save("notes.tmp")).outcome, "invalid");
  assert.equal((await save(".git/config")).outcome, "invalid");
  assert.equal((await save(`a/${"x".repeat(505)}.md`)).outcome, "invalid");
  assert.equal((await save("scripts/run.sh", "#!/bin/sh\necho ok\n")).outcome, "saved");
  assert.equal((await stat(join(dataDir, "skills/notes/scripts/run.sh"))).mode & 0o111, 0o111);
});

test("a name bb already delivers cannot be used for a new skill", async () => {
  const { change } = await setup();
  const result = await change({ op: "createSkill", name: "mcp", description: "Mine." });
  assert.equal(result.outcome, "invalid");
  assert.match(JSON.stringify(result), /hide the mcp skill from plugin bb-guide/);
});

test("deleting needs the version you saw, warns on incoming links, and can be restored from trash", async () => {
  const { dataDir, sourceDir, change, listing } = await setup();
  await writeSourceFile(sourceDir, "skills/probe/SKILL.md", skillMd("probe"));
  await writeSourceFile(
    sourceDir,
    "skills/dev/SKILL.md",
    skillMd("dev", "See [probe](../probe/SKILL.md).\n"),
  );
  const probe = (await listing()).skills.find((s) => s.name === "probe")!;

  const stale = await change({ op: "deleteSkill", name: "probe", expectedTreeSha: "0".repeat(64) });
  assert.equal(stale.outcome, "conflict");
  const deleted = await change({
    op: "deleteSkill",
    name: "probe",
    expectedTreeSha: probe.treeSha,
  });
  assert.equal(deleted.outcome, "saved");
  assert.match(JSON.stringify(deleted), /dev\/SKILL.md links into probe/);
  assert.equal(existsSync(join(dataDir, "skills/probe")), false);
  assert.deepEqual(
    (await listing()).deleted.map((d) => d.key),
    ["probe"],
  );

  const restored = await change({ op: "restore", kind: "skill", key: "probe" });
  assert.equal(restored.outcome, "saved");
  assert.match(await readFile(join(dataDir, "skills/probe/SKILL.md"), "utf8"), /name: probe/);
  assert.deepEqual((await listing()).deleted, []);
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

  const write = (content: string, expect: string) =>
    cli("skill", "write", "notes", "SKILL.md", "--content", content, "--expect", expect);
  const revision = (await listing()).revision;
  const newSha = /sha256 ([0-9a-f]{64})/.exec(written.stdout)?.[1] ?? "";
  assert.match((await write(body, newSha)).stdout, /unchanged; nothing saved/);
  const stale = await write(`${body}\nMore.`, sha);
  assert.notEqual(stale.exitCode, 0);
  assert.match(stale.stderr, /changed since you opened it/);
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
  const gone = await cli("skill", "delete", "notes", "--expect", tree);
  assert.equal(gone.exitCode, 0, gone.stderr);
  assert.equal(existsSync(join(dataDir, "skills/notes")), false);
});

test("agents can delete a binary skill file through the CLI", async () => {
  const { dataDir, sourceDir, cli } = await setup();
  await writeSourceFile(sourceDir, "skills/probe/SKILL.md", skillMd("probe"));
  await writeSourceFile(
    sourceDir,
    "skills/probe/assets/logo.png",
    Buffer.from([0x89, 0x50, 0x00, 0xff]),
  );

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
  spawnSync("chmod", ["a-w", skills]);
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
  const { dataDir, sourceDir, listing, cli } = await setup();
  await writeSourceFile(sourceDir, "instructions/shared.md", "Shared text.");
  const id = (await listing()).docs[0]!.id;

  const shown = await cli("doc", "show", id);
  assert.equal(shown.stdout, "Shared text.");
  const sha = /sha256 ([0-9a-f]{64})/.exec(shown.stderr)?.[1] ?? "";
  const revision = (await listing()).revision;
  const same = await cli("doc", "write", id, "--content", "Shared text.\n", "--expect", sha);
  assert.match(same.stdout, /unchanged; nothing saved/);
  assert.equal((await listing()).revision, revision);

  const written = await cli("doc", "write", id, "--content", "New shared text.\n", "--expect", sha);
  assert.equal(written.exitCode, 0, written.stderr);
  assert.equal(await readFile(join(dataDir, "AGENTS.md"), "utf8"), "New shared text.\n");
  assert.notEqual((await cli("doc", "write", id, "--content", "x", "--expect", sha)).exitCode, 0);

  const current = JSON.parse((await cli("doc", "show", id, "--json")).stdout).sha256;
  const del = await cli("doc", "delete", id, "--expect", current);
  assert.equal(del.exitCode, 0);
  assert.equal(existsSync(join(dataDir, "AGENTS.md")), false);
  assert.deepEqual(
    (await listing()).deleted.map((d) => d.kind),
    ["doc"],
  );
});

test("R2 #2: Node fs.watch survives migrate --apply atomic directory swap", async () => {
  const { dataDir, sourceDir, cli } = await setup();
  const pluginDir = join(dataDir, "plugins/agent-instructions");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(pluginDir, "data.db"));
  db.exec(`
    CREATE TABLE instruction_docs (id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, enabled INTEGER NOT NULL, position INTEGER NOT NULL, origin TEXT NOT NULL, rev INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO instruction_docs VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "doc_1",
    "Doc One",
    "Initial migrated doc.",
    1,
    0,
    "{}",
    1,
  );
  db.close();

  const mig = await cli("migrate", "--apply", "--force");
  assert.equal(mig.exitCode, 0, mig.stderr);
  assert.equal(await readFile(join(dataDir, "AGENTS.md"), "utf8"), "Initial migrated doc.\n");

  // Wait for any rename/delete debounce event from the directory swap itself to settle first.
  await new Promise((r) => setTimeout(r, 350));

  // Edit the swapped source/ directory directly on disk -> Node's inotify watcher MUST still fire!
  await writeSourceFile(sourceDir, "instructions/doc_1.md", "Edited after atomic swap.\n");
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    const current = await readFile(join(dataDir, "AGENTS.md"), "utf8").catch(() => "");
    if (current.includes("Edited after atomic swap.")) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(await readFile(join(dataDir, "AGENTS.md"), "utf8"), "Edited after atomic swap.\n");
});
