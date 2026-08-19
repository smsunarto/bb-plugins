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

test("round-trips Local and Orb session bindings through the file", () => {
  const path = tempStorePath();
  const store = createFileSessionStore(path);
  assert.equal(store.get("S-local"), null);
  store.set("S-local", { threadId: "T-local", executionTarget: "local" });
  store.set("S-orb", { threadId: "T-orb", executionTarget: "orb" });
  assert.deepEqual(store.get("S-local"), {
    threadId: "T-local",
    executionTarget: "local",
  });
  assert.deepEqual(store.get("S-orb"), {
    threadId: "T-orb",
    executionTarget: "orb",
  });

  // A second store instance over the same file sees both execution boundaries.
  const reopened = createFileSessionStore(path);
  assert.deepEqual(reopened.get("S-local"), {
    threadId: "T-local",
    executionTarget: "local",
  });
  assert.deepEqual(reopened.get("S-orb"), {
    threadId: "T-orb",
    executionTarget: "orb",
  });

  // The write is one real atomic record, keyed by a safe hash rather than
  // using the client-provided session id as a path.
  const raw = JSON.parse(readFileSync(recordPath(path, "S-orb"), "utf8")) as {
    sessionId: string;
    threadId: string;
    executionTarget: string;
  };
  assert.equal(raw.sessionId, "S-orb");
  assert.equal(raw.threadId, "T-orb");
  assert.equal(raw.executionTarget, "orb");
});

test("corrupt record: get returns null and set recovers", () => {
  const path = tempStorePath();
  const store = createFileSessionStore(path);
  store.set("S-old", { threadId: "T-old", executionTarget: "orb" });
  writeFileSync(recordPath(path, "S-old"), "{ not json", "utf8");

  assert.equal(store.get("S-old"), null);
  store.set("S-old", { threadId: "T-new", executionTarget: "local" });
  assert.deepEqual(store.get("S-old"), {
    threadId: "T-new",
    executionTarget: "local",
  });
});

test("record without an execution target migrates safely to Local", () => {
  const path = tempStorePath();
  mkdirSync(recordsDirectory(path), { recursive: true });
  writeFileSync(
    recordPath(path, "S-legacy"),
    JSON.stringify({
      sessionId: "S-legacy",
      threadId: "T-legacy",
      updatedAt: 1,
    }),
    "utf8",
  );

  const store = createFileSessionStore(path);
  assert.deepEqual(store.get("S-legacy"), {
    threadId: "T-legacy",
    executionTarget: "local",
  });
});

test("record with an invalid execution target fails closed", () => {
  const path = tempStorePath();
  mkdirSync(recordsDirectory(path), { recursive: true });
  writeFileSync(
    recordPath(path, "S-invalid"),
    JSON.stringify({
      sessionId: "S-invalid",
      threadId: "T-invalid",
      executionTarget: "remote",
      updatedAt: 1,
    }),
    "utf8",
  );

  const store = createFileSessionStore(path);
  assert.equal(store.get("S-invalid"), null);
});

test("migrates the legacy aggregate without overwriting newer records", () => {
  const path = tempStorePath();
  const existing = createFileSessionStore(path);
  existing.set("S-newer", { threadId: "T-newer", executionTarget: "orb" });
  writeFileSync(
    path,
    JSON.stringify({
      "S-legacy": { threadId: "T-legacy", updatedAt: 1 },
      "S-orb": { threadId: "T-orb", executionTarget: "orb", updatedAt: 1 },
      "S-newer": { threadId: "T-stale", executionTarget: "local", updatedAt: 1 },
    }),
    "utf8",
  );

  const migrated = createFileSessionStore(path);
  assert.deepEqual(migrated.get("S-legacy"), {
    threadId: "T-legacy",
    executionTarget: "local",
  });
  assert.deepEqual(migrated.get("S-orb"), {
    threadId: "T-orb",
    executionTarget: "orb",
  });
  assert.deepEqual(migrated.get("S-newer"), {
    threadId: "T-newer",
    executionTarget: "orb",
  });
  assert.equal(existsSync(path), false, "successful migration moves sessions.json aside");
});

test("prunes beyond MAX_ENTRIES, evicting the oldest updatedAt", () => {
  const path = tempStorePath();
  mkdirSync(recordsDirectory(path), { recursive: true });
  for (let index = 0; index < 200; index += 1) {
    writeFileSync(
      recordPath(path, `S-${index}`),
      JSON.stringify({
        sessionId: `S-${index}`,
        threadId: `T-${index}`,
        executionTarget: index % 2 === 0 ? "local" : "orb",
        updatedAt: index + 1,
      }),
      "utf8",
    );
  }

  const store = createFileSessionStore(path);
  store.set("S-new", { threadId: "T-new", executionTarget: "orb" });

  assert.equal(
    readdirSync(recordsDirectory(path)).filter((name) => name.endsWith(".json")).length,
    200,
  );
  assert.deepEqual(store.get("S-new"), {
    threadId: "T-new",
    executionTarget: "orb",
  });
  assert.equal(store.get("S-0"), null, "oldest entry should be evicted");
  assert.deepEqual(store.get("S-199"), {
    threadId: "T-199",
    executionTarget: "orb",
  });
});

test("concurrent bridge processes preserve every session mapping", async () => {
  const path = tempStorePath();
  const moduleUrl = pathToFileURL(
    join(dirname(fileURLToPath(import.meta.url)), "../src/session-store.ts"),
  ).href;
  const writers = Array.from(
    { length: 16 },
    (_, index) =>
      new Promise<void>((resolve, reject) => {
        const binding = {
          threadId: `T-${index}`,
          executionTarget: index % 2 === 0 ? "local" : "orb",
        };
        const source = [
          `import { createFileSessionStore } from ${JSON.stringify(moduleUrl)};`,
          `createFileSessionStore(${JSON.stringify(path)}).set(${JSON.stringify(`S-${index}`)}, ${JSON.stringify(binding)});`,
        ].join("\n");
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", "--input-type=module", "--eval", source],
          {
            env: { ...process.env, NODE_NO_WARNINGS: "1" },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        const stderr: Buffer[] = [];
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(`session writer exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`),
            );
          }
        });
      }),
  );

  await Promise.all(writers);
  const reopened = createFileSessionStore(path);
  for (let index = 0; index < writers.length; index += 1) {
    assert.deepEqual(reopened.get(`S-${index}`), {
      threadId: `T-${index}`,
      executionTarget: index % 2 === 0 ? "local" : "orb",
    });
  }
});

test("defaultSessionStorePath honors XDG_STATE_HOME", () => {
  const path = defaultSessionStorePath({ XDG_STATE_HOME: "/x/state" } as NodeJS.ProcessEnv);
  assert.equal(path, join("/x/state", "bb-plugin-amp", "sessions.json"));
});
