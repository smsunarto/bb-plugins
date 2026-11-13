import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createSudoHandlers } from "../src/host/handlers.ts";
import { createSudoRunner } from "../src/host/sudo.ts";
import plugin from "../src/server/server.ts";

const STUB = `#!/bin/sh
dir=$(dirname "$0")
printf '%s\\n' "$*" >> "$dir/calls.log"
IFS= read -r line || line=""
[ "$line" = "$(cat "$dir/password")" ] || { echo "Sorry, try again." >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    -v) exit 0 ;;
    --) shift; exec "$@" ;;
    *) shift ;;
  esac
done
exit 2
`;
const PASSWORD = "correct horse";
const THREAD = "thr_test";

let dir: string;
const seen = new Set<string>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scott-secrets-server-"));
  writeFileSync(join(dir, "password"), PASSWORD);
  writeFileSync(join(dir, "sudo"), STUB);
  chmodSync(join(dir, "sudo"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function load() {
  seen.clear();
  const sudo = createSudoHandlers(
    createSudoRunner({ binary: join(dir, "sudo"), timeoutBinary: null }),
  );
  const lease = { dispose: async () => {} };
  const { harness, bb } = createFakePluginHost({
    pluginId: "scott-secrets",
    sdk: {},
    experimental_callHostRpc: ({ method, input }) => {
      if (method === "sudoForget") return sudo.forget((input as { threadId: string }).threadId);
      if (method === "sudoRun") {
        return sudo.run(input as Parameters<typeof sudo.run>[0], {
          signal: new AbortController().signal,
          retain: () => lease,
        });
      }
      throw new Error(`unexpected host method ${method}`);
    },
  });
  harness.sdk.stub("threads.get", () => ({ id: THREAD, host: { id: "host_1", name: "dev-pc" } }));
  await plugin(bb);
  return { harness, sudo };
}

type Harness = Awaited<ReturnType<typeof load>>["harness"];

/** The next form the plugin opens; settled forms leave `pendingInteractions`. */
async function nextInteraction(harness: Harness) {
  for (let tries = 0; tries < 200; tries += 1) {
    const pending = harness.pendingInteractions.find((row) => !seen.has(row.id));
    if (pending) {
      seen.add(pending.id);
      return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("no interaction opened");
}

function sudoCli(harness: Harness, ...argv: string[]) {
  return harness.runCli(["sudo", "--purpose", "test", "--", ...argv], {
    threadId: THREAD,
    cwd: dir,
  });
}

test("first sudo asks for the password; later ones in the thread run without asking", async () => {
  const { harness } = await load();

  const first = sudoCli(harness, "echo", "one");
  const ask = await nextInteraction(harness);
  expect(ask.rendererId).toBe("sudo-request");
  expect(ask.payload).toMatchObject({ argv: ["echo", "one"], cwd: dir, host: "dev-pc" });
  const described = await ask.describeSubmission?.({ approved: true, password: PASSWORD });
  expect(JSON.stringify(described)).not.toContain(PASSWORD);
  harness.submitInteraction(ask.id, { approved: true, password: PASSWORD });
  expect(await first).toMatchObject({ exitCode: 0, stdout: "one\n" });

  expect(await sudoCli(harness, "sh", "-c", "echo two; exit 3")).toMatchObject({
    exitCode: 3,
    stdout: "two\n",
  });
  expect(harness.pendingInteractions).toHaveLength(0);
  expect(seen.size).toBe(1);

  const runs = harness.experimental_hostRpcCalls.filter((call) => call.method === "sudoRun");
  // cache miss, run with the typed password, then the cached run
  expect(runs).toHaveLength(3);
  expect(JSON.stringify(runs[2]?.input)).not.toContain(PASSWORD);
});

test("another thread still has to type the password", async () => {
  const { harness } = await load();
  const warm = sudoCli(harness, "true");
  harness.submitInteraction((await nextInteraction(harness)).id, {
    approved: true,
    password: PASSWORD,
  });
  await warm;

  const other = harness.runCli(["sudo", "--", "echo", "other"], {
    threadId: "thr_other",
    cwd: dir,
  });
  const ask = await nextInteraction(harness);
  expect(ask.threadId).toBe("thr_other");
  harness.cancelInteraction(ask.id);
  expect((await other).stderr).toContain("sudo request denied");
});

test("a denied request runs nothing", async () => {
  const { harness } = await load();
  const run = sudoCli(harness, "touch", join(dir, "ran"));
  harness.cancelInteraction((await nextInteraction(harness)).id);
  const result = await run;
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("sudo request denied");
  // Only the cache probe reached the host; sudo itself never ran.
  expect(
    harness.experimental_hostRpcCalls.filter((call) => call.method === "sudoRun"),
  ).toHaveLength(1);
  expect(existsSync(join(dir, "calls.log"))).toBe(false);
  expect(existsSync(join(dir, "ran"))).toBe(false);
});

test("a wrong password fails once with no retry and caches nothing", async () => {
  const { harness, sudo } = await load();
  const run = sudoCli(harness, "true");
  harness.submitInteraction((await nextInteraction(harness)).id, {
    approved: true,
    password: "wrong",
  });
  const result = await run;
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("sudo rejected the password");
  expect(harness.pendingInteractions).toHaveLength(0);
  expect(sudo.cache.status(THREAD).cached).toBe(false);
  expect(readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n")).toHaveLength(1);
});

test("an expired cache asks for the password again", async () => {
  const { harness, sudo } = await load();
  const warm = sudoCli(harness, "true");
  harness.submitInteraction((await nextInteraction(harness)).id, {
    approved: true,
    password: PASSWORD,
  });
  await warm;
  sudo.cache.clearAll(); // the window ends

  const run = sudoCli(harness, "echo", "late");
  harness.submitInteraction((await nextInteraction(harness)).id, {
    approved: true,
    password: PASSWORD,
  });
  expect(await run).toMatchObject({ exitCode: 0, stdout: "late\n" });
});

test("passthrough argv is not folded like --describe pairs", async () => {
  const { harness } = await load();
  const run = sudoCli(harness, "echo", "--describe", "NAME", "text");
  harness.submitInteraction((await nextInteraction(harness)).id, {
    approved: true,
    password: PASSWORD,
  });
  expect(await run).toMatchObject({ exitCode: 0, stdout: "--describe NAME text\n" });
});

test("sudo without a command is rejected before any form opens", async () => {
  const { harness } = await load();
  const result = await harness.runCli(["sudo"], { threadId: THREAD, cwd: dir });
  expect(result.exitCode).not.toBe(0);
  expect(harness.pendingInteractions).toHaveLength(0);
});

test("forget-sudo drops the cached password", async () => {
  const { harness, sudo } = await load();
  const warm = sudoCli(harness, "true");
  harness.submitInteraction((await nextInteraction(harness)).id, {
    approved: true,
    password: PASSWORD,
  });
  await warm;
  const result = await harness.runCli(["forget-sudo"], { threadId: THREAD, cwd: dir });
  expect(JSON.parse(result.stdout ?? "")).toEqual({
    host: "dev-pc",
    thread: THREAD,
    forgotten: true,
  });
  expect(sudo.cache.status(THREAD).cached).toBe(false);
});

test("request still writes the dotenv file with mode 0600", async () => {
  const { harness } = await load();
  const writes: unknown[] = [];
  harness.sdk.stub("files.read", () => {
    throw Object.assign(new Error("missing"), { status: 404 });
  });
  harness.sdk.stub("files.write", (input: never) => {
    writes.push(input);
    return { outcome: "written" };
  });
  const run = harness.runCli(
    ["request", "API_KEY", "--describe", "API_KEY", "The key", "--write-env", ".env"],
    { threadId: THREAD, cwd: dir },
  );
  const ask = await nextInteraction(harness);
  expect(ask.payload).toMatchObject({ fields: [{ name: "API_KEY", description: "The key" }] });
  harness.submitInteraction(ask.id, { values: { API_KEY: "s3cret" } });
  const result = await run;
  expect(JSON.parse(result.stdout ?? "")).toEqual({
    path: join(dir, ".env"),
    names: ["API_KEY"],
    added: 1,
    updated: 0,
    unchanged: 0,
  });
  expect(writes[0]).toMatchObject({ content: "API_KEY='s3cret'\n", mode: 0o600 });
});
