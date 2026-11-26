import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { treeSha } from "../catalog/tree.ts";
import plugin from "../server/server.ts";
import { ANYWHERE, type Rule } from "../shared/rules.ts";
import { sha256Bytes } from "../sync/paths.ts";
import {
  formatMigrationReport,
  openReadOnlySqlite,
  readLegacySqlite,
  runMigration,
  type LegacyData,
} from "./migrate.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function makeTemp(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(async () => {
    spawnSync("chmod", ["-R", "u+w", dir]);
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const bunSqlite = "bun:sqlite";
const { Database } = (await import(bunSqlite)) as {
  Database: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): void };
    close(): void;
  };
};

function seedLegacyDb(dbPath: string): {
  binaryBytes: Uint8Array;
  skillMdBytes: Uint8Array;
  scriptBytes: Uint8Array;
} {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE catalog_revisions (rev INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, summary TEXT NOT NULL);
    CREATE TABLE instruction_docs (id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, enabled INTEGER NOT NULL, position INTEGER NOT NULL, origin TEXT NOT NULL, rev INTEGER NOT NULL);
    CREATE TABLE skills (name TEXT PRIMARY KEY, description TEXT NOT NULL, enabled INTEGER NOT NULL, origin TEXT NOT NULL, tree_sha TEXT NOT NULL, rev INTEGER NOT NULL);
    CREATE TABLE skill_files (skill TEXT NOT NULL, path TEXT NOT NULL, executable INTEGER NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (skill, path));
    CREATE TABLE catalog_deleted (kind TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, rev INTEGER NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (kind, key));
  `);

  db.prepare("INSERT INTO instruction_docs VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "imported:shared",
    "Global instructions",
    "# Shared\n\nAlways be direct.",
    1,
    0,
    JSON.stringify({ kind: "authored" }),
    1,
  );
  db.prepare("INSERT INTO instruction_docs VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "doc_off",
    "Disabled doc",
    "Not published.",
    0,
    1,
    JSON.stringify({ kind: "authored" }),
    1,
  );

  const skillMdBytes = Buffer.from(
    "---\nname: alpha\ndescription: Alpha skill\n---\n\n# Alpha\n",
    "utf8",
  );
  const scriptBytes = Buffer.from("#!/bin/sh\necho ok\n", "utf8");
  const binaryBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x01]);
  const alphaFiles = [
    { path: "SKILL.md", executable: false, sha256: sha256Bytes(skillMdBytes), bytes: skillMdBytes },
    {
      path: "scripts/run.sh",
      executable: true,
      sha256: sha256Bytes(scriptBytes),
      bytes: scriptBytes,
    },
    {
      path: "assets/icon.bin",
      executable: false,
      sha256: sha256Bytes(binaryBytes),
      bytes: binaryBytes,
    },
  ];
  db.prepare("INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?)").run(
    "alpha",
    "Alpha skill",
    1,
    JSON.stringify({ kind: "authored" }),
    treeSha(alphaFiles),
    1,
  );
  for (const f of alphaFiles) {
    db.prepare("INSERT INTO skill_files VALUES (?, ?, ?, ?, ?)").run(
      "alpha",
      f.path,
      f.executable ? 1 : 0,
      f.sha256,
      f.bytes,
    );
  }

  const offSkillMd = Buffer.from(
    "---\nname: paused\ndescription: Paused skill\n---\n\nBody.\n",
    "utf8",
  );
  const offFiles = [
    { path: "SKILL.md", executable: false, sha256: sha256Bytes(offSkillMd), bytes: offSkillMd },
  ];
  db.prepare("INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?)").run(
    "paused",
    "Paused skill",
    0,
    JSON.stringify({ kind: "imported", from: "skills/paused" }),
    treeSha(offFiles),
    1,
  );
  db.prepare("INSERT INTO skill_files VALUES (?, ?, ?, ?, ?)").run(
    "paused",
    "SKILL.md",
    0,
    offFiles[0]!.sha256,
    offSkillMd,
  );

  db.prepare("INSERT INTO catalog_deleted VALUES (?, ?, ?, ?, ?, ?)").run(
    "skill",
    "old-deleted",
    "old-deleted",
    1,
    1000,
    "{}",
  );
  db.close();
  return { binaryBytes, skillMdBytes, scriptBytes };
}

const sampleRules: Rule[] = [
  {
    id: "rule_steer",
    name: "Steer",
    enabled: true,
    instructions: "Always pass --mode steer.",
    when: { ...ANYWHERE },
  },
  {
    id: "rule_codex",
    name: "Codex web",
    enabled: false,
    instructions: "Use curl.\nLine 2.",
    when: { hosts: ["host_1"], providers: ["codex"], models: ["gpt-5*"], projects: ["proj_1"] },
  },
];

test("dry-run and apply migration export docs, skills (binary + exec), and rules losslessly", async () => {
  const dir = await makeTemp("migrate-test-");
  const dbPath = join(dir, "data.db");
  const targetDir = join(dir, "source");
  const tmpDir = join(dir, ".tmp");
  const markerPath = join(dir, "migration.json");
  const { binaryBytes, scriptBytes } = seedLegacyDb(dbPath);

  const opened = await openReadOnlySqlite(dbPath);
  let data: LegacyData;
  try {
    data = { ...readLegacySqlite(opened.db), rules: sampleRules };
  } finally {
    opened.close();
  }

  // Dry run writes nothing
  const dry = await runMigration({ data, targetDir, tmpDir, markerPath, apply: false });
  expect(dry.dryRun).toBe(true);
  expect(dry.applied).toBe(false);
  expect(dry.verification.ok).toBe(true);
  expect(dry.plan.docs.map((d) => d.relPath)).toEqual([
    "instructions/shared.md",
    "instructions/doc_off.md",
  ]);
  expect(dry.plan.skippedDeleted.map((d) => d.key)).toEqual(["old-deleted"]);
  expect(existsSync(targetDir)).toBe(false);
  expect(formatMigrationReport(dry)).toContain("PASS — 0 mismatches");

  // Apply exports and verifies byte-for-byte on disk
  const applied = await runMigration({ data, targetDir, tmpDir, markerPath, apply: true });
  expect(applied.applied).toBe(true);
  expect(applied.verification.ok).toBe(true);
  expect(applied.verification.agentsMdMatched).toBe(true);
  expect(applied.verification.skillFilesChecked).toBe(4);
  expect(existsSync(markerPath)).toBe(true);

  expect(new Uint8Array(await readFile(join(targetDir, "skills/alpha/assets/icon.bin")))).toEqual(
    new Uint8Array(binaryBytes),
  );
  expect(new Uint8Array(await readFile(join(targetDir, "skills/alpha/scripts/run.sh")))).toEqual(
    new Uint8Array(scriptBytes),
  );
  expect((await stat(join(targetDir, "skills/alpha/scripts/run.sh"))).mode & 0o111).toBe(0o111);
  expect(existsSync(join(targetDir, "skills/paused/.disabled"))).toBe(true);
  expect(existsSync(join(targetDir, "skills/old-deleted"))).toBe(false);

  // Refuses to overwrite non-empty target without --force
  await expect(runMigration({ data, targetDir, tmpDir, markerPath, apply: true })).rejects.toThrow(
    "already contains files",
  );
});

test("plugin startup auto-migrates legacy data.db + KV state once, auto-publishes, and stays idempotent on reload", async () => {
  const dataDir = await makeTemp("auto-migrate-");
  const pluginDir = join(dataDir, "plugins", "agent-instructions");
  await mkdir(pluginDir, { recursive: true });
  seedLegacyDb(join(pluginDir, "data.db"));

  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-instructions",
    dataDir,
    sdk: {
      hosts: { list: async () => [] },
      providers: { list: async () => [] },
      projects: { list: async () => [] },
    },
  });
  cleanup.push(() => harness.lifecycle.dispose());
  await bb.storage.kv.set("state", { revision: 3, rules: sampleRules });

  await plugin(bb);

  // Wait for startup auto-publish without manually calling runCli(["publish"]).
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      existsSync(join(dataDir, "AGENTS.md")) &&
      existsSync(join(dataDir, "skills/alpha/SKILL.md"))
    )
      break;
    await new Promise((r) => setTimeout(r, 30));
  }

  expect(existsSync(join(pluginDir, "migration.json"))).toBe(true);
  expect(await readFile(join(dataDir, "AGENTS.md"), "utf8")).toBe(
    "# Shared\n\nAlways be direct.\n",
  );
  expect(existsSync(join(dataDir, "skills/alpha/SKILL.md"))).toBe(true);
  expect(existsSync(join(dataDir, "skills/paused"))).toBe(false);

  const rulesOut = (await harness.callRpc("rules")) as { rules: Rule[] };
  expect(rulesOut.rules).toEqual(sampleRules);

  // Edit source/instructions/shared.md and reload -> migration.json prevents re-migrating over edits!
  await writeFile(
    join(pluginDir, "source/instructions/shared.md"),
    "Post-migration edit.\n",
    "utf8",
  );
  const reloaded = await harness.reload(plugin);
  cleanup.push(() => reloaded.harness.lifecycle.dispose());
  expect(await readFile(join(pluginDir, "source/instructions/shared.md"), "utf8")).toBe(
    "Post-migration edit.\n",
  );

  // Test `migrate` CLI dry-run and `--apply --force` with pre-existing extra files & stale .disabled (#10, #23, #28).
  await writeFile(join(pluginDir, "source/instructions/extra.md"), "Stale extra.\n", "utf8");
  await writeFile(join(pluginDir, "source/skills/alpha/.disabled"), "", "utf8");
  const dryCli = await reloaded.harness.behavior.runCli(["migrate"]);
  expect(dryCli.exitCode).toBe(0);
  expect(dryCli.stdout).toContain("PASS — 0 mismatches");

  const forceCli = await reloaded.harness.behavior.runCli(["migrate", "--apply", "--force"]);
  expect(forceCli.exitCode).toBe(0);
  expect(existsSync(join(pluginDir, "source/instructions/extra.md"))).toBe(false);
  expect(existsSync(join(pluginDir, "source/skills/alpha/.disabled"))).toBe(false);
  expect(await readFile(join(dataDir, "AGENTS.md"), "utf8")).toBe(
    "# Shared\n\nAlways be direct.\n",
  );
});

test("#22 & #34: colliding 80-char doc ids stay <= 80 chars, NUL bytes fail cleanly, and report prints skillBytes", async () => {
  const dir = await makeTemp("migrate-edge-");
  const stem80 = "a".repeat(80);
  const res = await runMigration({
    data: {
      docs: [
        { id: stem80, name: "First", body: "One.", enabled: true, position: 0 },
        { id: `imported:${stem80}`, name: "Second", body: "Two.", enabled: false, position: 1 },
      ],
      rules: [],
      skills: [],
      deleted: [],
    },
    targetDir: join(dir, "source"),
    tmpDir: join(dir, ".tmp"),
    apply: true,
  });
  expect(res.verification.ok).toBe(true);
  expect(res.plan.docs.every((d) => d.id.length <= 80)).toBe(true);
  expect(res.plan.docs[0]!.id).not.toBe(res.plan.docs[1]!.id);
  expect(formatMigrationReport(res)).toContain("0.0 KiB skills");

  // NUL byte in doc body is caught in planMigration instead of silently dropped post-migration.
  const nulDry = await runMigration({
    data: {
      docs: [{ id: "bad", name: "Bad", body: "a\0b", enabled: true, position: 0 }],
      rules: [],
      skills: [],
      deleted: [],
    },
    targetDir: join(dir, "source-nul"),
    tmpDir: join(dir, ".tmp"),
    apply: false,
  });
  expect(nulDry.verification.ok).toBe(false);
  expect(nulDry.plan.errors.some((e) => e.includes("binary/NUL"))).toBe(true);
});
