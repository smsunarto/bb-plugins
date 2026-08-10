import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFileSessionStore, defaultSessionStorePath } from "../src/session-store.ts";

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "bb-amp-store-")), "sessions.json");
}

function recordsDirectory(path: string): string {
  return join(dirname(path), "sessions");
}

function recordPath(path: string, sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return join(recordsDirectory(path), `${digest}.json`);
}

test("round-trips sessionId -> threadId through the file", () => {
  const path = tempStorePath();
  const store = createFileSessionStore(path);
  assert.equal(store.get("S-1"), null);
  store.set("S-1", "T-1");
  assert.equal(store.get("S-1"), "T-1");

  // A second store instance over the same file sees the mapping.
  const reopened = createFileSessionStore(path);
  assert.equal(reopened.get("S-1"), "T-1");

  // The write is one real atomic record, keyed by a safe hash rather than
  // using the client-provided session id as a path.
  const raw = JSON.parse(readFileSync(recordPath(path, "S-1"), "utf8")) as {
    sessionId: string;
    threadId: string;
  };
  assert.equal(raw.sessionId, "S-1");
  assert.equal(raw.threadId, "T-1");
});

test("corrupt record: get returns null and set recovers", () => {
  const path = tempStorePath();
  const store = createFileSessionStore(path);
  store.set("S-old", "T-old");
  writeFileSync(recordPath(path, "S-old"), "{ not json", "utf8");

  assert.equal(store.get("S-old"), null);
  store.set("S-old", "T-new");
  assert.equal(store.get("S-old"), "T-new");
});

test("migrates the legacy aggregate without overwriting newer records", () => {
  const path = tempStorePath();
  const existing = createFileSessionStore(path);
  existing.set("S-newer", "T-newer");
  writeFileSync(path, JSON.stringify({
    "S-legacy": { threadId: "T-legacy", updatedAt: 1 },
    "S-newer": { threadId: "T-stale", updatedAt: 1 },
  }), "utf8");

  const migrated = createFileSessionStore(path);
  assert.equal(migrated.get("S-legacy"), "T-legacy");
  assert.equal(migrated.get("S-newer"), "T-newer");
  assert.equal(existsSync(path), false, "successful migration moves sessions.json aside");
});

test("prunes beyond MAX_ENTRIES, evicting the oldest updatedAt", () => {
  const path = tempStorePath();
  mkdirSync(recordsDirectory(path), { recursive: true });
  for (let index = 0; index < 200; index += 1) {
    writeFileSync(recordPath(path, `S-${index}`), JSON.stringify({
      sessionId: `S-${index}`,
      threadId: `T-${index}`,
      updatedAt: index + 1,
    }), "utf8");
  }

  const store = createFileSessionStore(path);
  store.set("S-new", "T-new");

  assert.equal(readdirSync(recordsDirectory(path)).filter((name) => name.endsWith(".json")).length, 200);
  assert.equal(store.get("S-new"), "T-new");
  assert.equal(store.get("S-0"), null, "oldest entry should be evicted");
  assert.equal(store.get("S-199"), "T-199");
});

test("concurrent bridge processes preserve every session mapping", async () => {
  const path = tempStorePath();
  const moduleUrl = pathToFileURL(join(
    dirname(fileURLToPath(import.meta.url)),
    "../src/session-store.ts",
  )).href;
  const writers = Array.from({ length: 16 }, (_, index) => new Promise<void>((resolve, reject) => {
    const source = [
      `import { createFileSessionStore } from ${JSON.stringify(moduleUrl)};`,
      `createFileSessionStore(${JSON.stringify(path)}).set(${JSON.stringify(`S-${index}`)}, ${JSON.stringify(`T-${index}`)});`,
    ].join("\n");
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      source,
    ], {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`session writer exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
      }
    });
  }));

  await Promise.all(writers);
  const reopened = createFileSessionStore(path);
  for (let index = 0; index < writers.length; index += 1) {
    assert.equal(reopened.get(`S-${index}`), `T-${index}`);
  }
});

test("defaultSessionStorePath honors XDG_STATE_HOME", () => {
  const path = defaultSessionStorePath({ XDG_STATE_HOME: "/x/state" } as NodeJS.ProcessEnv);
  assert.equal(path, join("/x/state", "bb-plugin-amp", "sessions.json"));
});
