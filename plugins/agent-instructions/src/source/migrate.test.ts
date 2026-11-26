import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

test("plugin startup auto-migrates legacy data.db + KV state once and publishes", async () => {
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
  const published = await harness.behavior.runCli(["publish"]);
  expect(published.exitCode).toBe(0);

  expect(existsSync(join(pluginDir, "migration.json"))).toBe(true);
  expect(await readFile(join(dataDir, "AGENTS.md"), "utf8")).toBe(
    "# Shared\n\nAlways be direct.\n",
  );
  expect(existsSync(join(dataDir, "skills/alpha/SKILL.md"))).toBe(true);
  expect(existsSync(join(dataDir, "skills/paused"))).toBe(false);

  const rulesOut = (await harness.callRpc("rules")) as { rules: Rule[] };
  expect(rulesOut.rules).toEqual(sampleRules);
});
