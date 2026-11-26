import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { treeSha } from "./catalog/tree.ts";
import hostEntry from "./host.ts";
import plugin from "./server/server.ts";
import { runMigration } from "./source/migrate.ts";
import { syncHostMethods } from "./sync/host-contract.ts";
import {
  conflictPathFor,
  isSafeSyncPath,
  MAX_SYNC_FILE_BYTES,
  MAX_SYNC_PATH_BYTES,
  readSyncFile,
  sha256Bytes,
  SymlinkRefusedError,
} from "./sync/paths.ts";

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

async function writeText(filePath: string, content: string) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

const bunSqlite = "bun:sqlite";
const { Database } = (await import(bunSqlite)) as {
  Database: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): void };
    close(): void;
  };
};

function createLegacyDb(dbPath: string, extra?: (db: InstanceType<typeof Database>) => void) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE catalog_revisions (rev INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, summary TEXT NOT NULL);
    CREATE TABLE instruction_docs (id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, enabled INTEGER NOT NULL, position INTEGER NOT NULL, origin TEXT NOT NULL, rev INTEGER NOT NULL);
    CREATE TABLE skills (name TEXT PRIMARY KEY, description TEXT NOT NULL, enabled INTEGER NOT NULL, origin TEXT NOT NULL, tree_sha TEXT NOT NULL, rev INTEGER NOT NULL);
    CREATE TABLE skill_files (skill TEXT NOT NULL, path TEXT NOT NULL, executable INTEGER NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (skill, path));
    CREATE TABLE catalog_deleted (kind TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, rev INTEGER NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (kind, key));
  `);
  const skillMd = Buffer.from("---\nname: alpha\ndescription: Alpha\n---\n\nBody\n", "utf8");
  const files = [{ path: "SKILL.md", executable: false, sha256: sha256Bytes(skillMd) }];
  db.prepare("INSERT INTO instruction_docs VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "doc_1",
    "Doc One",
    "Doc 1 body.",
    1,
    0,
    "{}",
    1,
  );
  db.prepare("INSERT INTO instruction_docs VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "doc_2",
    "Doc Two",
    "Doc 2 body.",
    1,
    1,
    "{}",
    1,
  );
  db.prepare("INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?)").run(
    "alpha",
    "Alpha",
    1,
    "{}",
    treeSha(files),
    1,
  );
  db.prepare("INSERT INTO skill_files VALUES (?, ?, ?, ?, ?)").run(
    "alpha",
    "SKILL.md",
    0,
    files[0]!.sha256,
    skillMd,
  );
  extra?.(db);
  db.close();
}

// #1: Truncated, symlinked, or oversized entries in walkSyncTree must NEVER trigger mass deletion.
test("#1: symlinked dir, oversized file, or truncated mirror walk never deletes server files", async () => {
  const serverDataDir = await makeTemp("safety-1-server-");
  const hostDataDir = await makeTemp("safety-1-host-");
  const outsideDir = await makeTemp("safety-1-outside-");
  const machine = experimental_createHostEntryHarness(hostEntry, {
    experimental_paths: { dataDir: hostDataDir, tempDir: join(hostDataDir, "tmp") },
  });
  cleanup.push(() => machine.experimental_dispose());

  let forceTruncated = false;
  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-instructions",
    dataDir: serverDataDir,
    experimental_callHostRpc: async (call) => {
      const res = (await machine.experimental_call(call.method as never, call.input as never)) as
        | Record<string, unknown>
        | undefined;
      if (
        forceTruncated &&
        (call.method === "mirrorEnsureWatch" || call.method === "mirrorSnapshot") &&
        res
      ) {
        return { ...res, manifest: {}, truncated: true };
      }
      return res;
    },
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_server" }) as never },
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host_server", name: "Server", status: "connected" }),
          makeHostResponse({ id: "host_mac", name: "Mac", status: "connected" }),
        ],
      },
      providers: { list: async () => [] },
      projects: { list: async () => [] },
    },
  });
  cleanup.push(() => harness.lifecycle.dispose());
  await plugin(bb);

  const sourceDir = join(serverDataDir, "plugins/agent-instructions/source");
  const mirrorDir = join(hostDataDir, "mirror");
  await writeText(join(sourceDir, "instructions/keep.md"), "Keep me.\n");
  await writeText(
    join(sourceDir, "rules/r1.md"),
    "---\nname: Keep rule\nenabled: true\n---\n\nKeep rule.\n",
  );
  await writeText(
    join(sourceDir, "skills/alpha/SKILL.md"),
    "---\nname: alpha\ndescription: Alpha\n---\n\nKeep skill.\n",
  );

  expect((await harness.behavior.runCli(["sync"])).exitCode).toBe(0);

  // Case A: replace mirror's skills/ directory with a symlink -> server skills/alpha/SKILL.md MUST survive.
  await rm(join(mirrorDir, "skills"), { recursive: true, force: true });
  await symlink(outsideDir, join(mirrorDir, "skills"));
  await harness.behavior.runCli(["sync"]);
  expect(existsSync(join(sourceDir, "skills/alpha/SKILL.md"))).toBe(true);

  // Restore skills dir before Case B.
  await rm(join(mirrorDir, "skills"), { recursive: true, force: true });
  await mkdir(join(mirrorDir, "skills"), { recursive: true });
  await harness.behavior.runCli(["sync"]);

  // Case B: grow mirror's instructions/keep.md past MAX_SYNC_FILE_BYTES -> server keep.md MUST survive.
  await writeFile(join(mirrorDir, "instructions/keep.md"), Buffer.alloc(MAX_SYNC_FILE_BYTES + 10));
  await harness.behavior.runCli(["sync"]);
  expect(existsSync(join(sourceDir, "instructions/keep.md"))).toBe(true);

  // Case C: truncated mirror snapshot -> server rules/r1.md MUST survive.
  forceTruncated = true;
  await harness.behavior.runCli(["sync"]);
  expect(existsSync(join(sourceDir, "rules/r1.md"))).toBe(true);
});

// #2: Live server migrate CLI must not accept arbitrary --target / --source-db / --source-rules-json path flags.
test("#2: migrate CLI refuses arbitrary --target and --source-db path flags", async () => {
  const serverDataDir = await makeTemp("safety-2-server-");
  const arbitraryTarget = await makeTemp("safety-2-target-");
  const craftedDbDir = await makeTemp("safety-2-db-");
  const craftedDb = join(craftedDbDir, "payload.db");
  createLegacyDb(craftedDb);

  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-instructions",
    dataDir: serverDataDir,
    sdk: {
      hosts: { list: async () => [] },
      providers: { list: async () => [] },
      projects: { list: async () => [] },
    },
  });
  cleanup.push(() => harness.lifecycle.dispose());
  await plugin(bb);

  const res = await harness.behavior.runCli([
    "migrate",
    "--source-db",
    craftedDb,
    "--target",
    arbitraryTarget,
    "--apply",
    "--force",
  ]);
  expect(res.exitCode).not.toBe(0);
  expect(existsSync(join(arbitraryTarget, "skills/alpha/SKILL.md"))).toBe(false);
});

// #3: Thread callers cannot override --host to read files from another host, and syncHostMethods has no readText.
test("#3: edit --file refuses cross-host --host override inside a thread and readText RPC is removed", async () => {
  expect("readText" in syncHostMethods).toBe(false);

  const serverDataDir = await makeTemp("safety-3-server-");
  const secretDir = await makeTemp("safety-3-secret-");
  const secretPath = join(secretDir, "id_rsa");
  await writeFile(secretPath, "PRIVATE_KEY_DATA", "utf8");

  let readCalledOnHostB = false;
  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-instructions",
    dataDir: serverDataDir,
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({ id: "thr_a", projectId: "proj_1", environmentId: "env_a" }),
      },
      environments: {
        get: async () => ({ id: "env_a", hostId: "host_a" }) as never,
      },
      files: {
        read: async (req: { hostId: string; path: string }) => {
          if (req.hostId === "host_b") readCalledOnHostB = true;
          const content = await readFile(req.path, "utf8");
          return {
            content,
            contentEncoding: "utf8",
            sizeBytes: Buffer.byteLength(content, "utf8"),
            sha256: sha256Bytes(content),
          } as never;
        },
      } as never,
      hosts: { list: async () => [] },
      providers: { list: async () => [] },
      projects: { list: async () => [] },
    },
  });
  cleanup.push(() => harness.lifecycle.dispose());
  await plugin(bb);

  await harness.behavior.runCli(["skill", "create", "notes", "--description", "Notes."]);
  const res = await harness.behavior.runCli(
    [
      "skill",
      "write",
      "notes",
      "leak.txt",
      "--host",
      "host_b",
      "--file",
      secretPath,
      "--expect",
      "new",
    ],
    { cwd: "/", threadId: "thr_a" } as never,
  );
  expect(res.exitCode).not.toBe(0);
  expect(readCalledOnHostB).toBe(false);
});

// #7: writeRulesUnlocked must NOT delete unparseable rules/*.md files on unrelated rule edits.
test("#7: unparseable rules/*.md file is preserved when adding or saving another rule", async () => {
  const serverDataDir = await makeTemp("safety-7-server-");
  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-instructions",
    dataDir: serverDataDir,
    sdk: {
      hosts: { list: async () => [] },
      providers: { list: async () => [] },
      projects: { list: async () => [] },
    },
  });
  cleanup.push(() => harness.lifecycle.dispose());
  await plugin(bb);

  const sourceDir = join(serverDataDir, "plugins/agent-instructions/source");
  const brokenPath = join(sourceDir, "rules/broken.md");
  await writeText(brokenPath, "---\ninvalid: [\n---\nhi\n");

  const added = await harness.behavior.runCli(["add", "other valid rule"]);
  expect(added.exitCode).toBe(0);
  expect(existsSync(brokenPath)).toBe(true);
  expect(await readFile(brokenPath, "utf8")).toBe("---\ninvalid: [\n---\nhi\n");
});

// #8: Mid-migration partial source/ without migration.json must not silently truncate published catalog;
//     and a failed runMigration must not leave partial files in targetDir.
test("#8: partial source without migration.json refuses silent truncation and runMigration stages atomically", async () => {
  const dataDir = await makeTemp("safety-8-server-");
  const pluginDir = join(dataDir, "plugins/agent-instructions");
  await mkdir(pluginDir, { recursive: true });
  createLegacyDb(join(pluginDir, "data.db"));

  // Pre-seed a partial source/ with only 1 file and NO migration.json, plus an existing published skill link.
  await writeText(join(pluginDir, "source/instructions/doc_1.md"), "Doc 1 body.\n");
  const fakeTree = join(pluginDir, "skill-trees/alpha/existing");
  await writeText(join(fakeTree, "SKILL.md"), "---\nname: alpha\ndescription: Alpha\n---\n");
  await mkdir(join(dataDir, "skills"), { recursive: true });
  await symlink(
    "../plugins/agent-instructions/skill-trees/alpha/existing",
    join(dataDir, "skills/alpha"),
  );

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
  await plugin(bb);

  // Give startup publish a moment to run if it mistakenly tried to.
  await new Promise((r) => setTimeout(r, 150));
  // Must NOT silently unlink alpha from user-tier skills!
  expect(existsSync(join(dataDir, "skills/alpha"))).toBe(true);
  expect(existsSync(join(pluginDir, "migration.json"))).toBe(false);

  // Also verify runMigration with an error leaves targetDir untouched (no partial files).
  const stageDir = await makeTemp("safety-8-atomic-");
  const targetDir = join(stageDir, "source");
  await expect(
    runMigration({
      data: {
        docs: [{ id: "ok", name: "Ok", body: "hi", enabled: true, position: 0 }],
        rules: [],
        skills: [
          {
            name: "bad",
            description: "Bad",
            enabled: true,
            treeSha: "0".repeat(64),
            files: [
              {
                path: "SKILL.md",
                executable: false,
                sha256: sha256Bytes("mismatch"),
                bytes: Buffer.from("actual"),
              },
            ],
          },
        ],
        deleted: [],
      },
      targetDir,
      tmpDir: join(stageDir, ".tmp"),
      apply: true,
    }),
  ).rejects.toThrow();
  expect(existsSync(join(targetDir, "instructions/ok.md"))).toBe(false);
});

// #9: Startup must not crash on corrupt KV state, whitespace doc name, or .DS_Store / .disabled skill file.
test("#9: plugin startup handles corrupt KV, whitespace doc name, and .DS_Store/.disabled skill files without crashing", async () => {
  const dataDir = await makeTemp("safety-9-server-");
  const pluginDir = join(dataDir, "plugins/agent-instructions");
  await mkdir(pluginDir, { recursive: true });
  createLegacyDb(join(pluginDir, "data.db"), (db) => {
    db.prepare("UPDATE instruction_docs SET name = '  Global  ' WHERE id = 'doc_1'").run();
    const ds = Buffer.from("junk", "utf8");
    db.prepare("INSERT INTO skill_files VALUES (?, ?, ?, ?, ?)").run(
      "alpha",
      ".DS_Store",
      0,
      sha256Bytes(ds),
      ds,
    );
  });

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
  await bb.storage.kv.set("state", "corrupt-not-an-object");

  // Must boot cleanly without throwing!
  await plugin(bb);
  const catalog = await harness.behavior.runCli(["catalog", "--json"]);
  expect(catalog.exitCode).toBe(0);
});

// #19: readSyncFile refuses symlinks via O_NOFOLLOW and enforces post-read size cap.
test("#19: readSyncFile enforces O_NOFOLLOW and MAX_SYNC_FILE_BYTES", async () => {
  const dir = await makeTemp("safety-19-");
  const outside = await makeTemp("safety-19-out-");
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "SECRET", "utf8");

  await mkdir(join(dir, "instructions"), { recursive: true });
  await symlink(secret, join(dir, "instructions/link.md"));
  await expect(readSyncFile(dir, "instructions/link.md")).rejects.toThrow(SymlinkRefusedError);

  // Oversized file is refused.
  await writeFile(join(dir, "instructions/huge.md"), Buffer.alloc(MAX_SYNC_FILE_BYTES + 1));
  await expect(readSyncFile(dir, "instructions/huge.md")).rejects.toThrow(/sync limit/);

  // Confirm paths.ts uses O_NOFOLLOW for reading (static guard against regression to path-based readFile).
  const pathsSrc = await readFile(
    fileURLToPath(new URL("./sync/paths.ts", import.meta.url)),
    "utf8",
  );
  expect(pathsSrc).toContain("O_NOFOLLOW");
});

// #20: conflictPathFor bounds byte length <= 512, strips nested conflict prefixes, and avoids same-second overwrites.
test("#20: conflictPathFor bounds length <= 512, avoids nesting, and disambiguates same-second conflicts", () => {
  const longRel = `skills/my-skill/${"a".repeat(480)}.md`;
  expect(isSafeSyncPath(longRel)).toBe(true);

  const c1 = conflictPathFor(longRel, "dev-mac", "20261126-043000");
  const c2 = conflictPathFor(longRel, "dev-mac", "20261126-043000");

  expect(Buffer.byteLength(c1, "utf8")).toBeLessThanOrEqual(MAX_SYNC_PATH_BYTES);
  expect(isSafeSyncPath(c1)).toBe(true);
  expect(c1).not.toBe(c2);

  // Nested conflict path does not accumulate multiple host-timestamp prefixes.
  const nested = conflictPathFor(c1, "dev-mac", "20261126-043001");
  expect(Buffer.byteLength(nested, "utf8")).toBeLessThanOrEqual(MAX_SYNC_PATH_BYTES);
  expect(isSafeSyncPath(nested)).toBe(true);
  expect(nested.match(/dev-mac-\d{8}-\d{6}/g)?.length).toBe(1);
});
