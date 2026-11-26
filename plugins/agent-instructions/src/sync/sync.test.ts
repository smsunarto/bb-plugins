import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createFakePluginHost,
  makeHostResponse,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host.ts";
import plugin from "../server/server.ts";
import { deleteSyncFileAndPrune, readSyncFile, SymlinkRefusedError } from "./paths.ts";

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

const skillMd = (name: string, body = "") =>
  `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n${body}`;

async function writeText(filePath: string, content: string) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function setupTwoHostEnv() {
  const serverDataDir = await makeTemp("sync-server-");
  const macHostDataDir = await makeTemp("sync-mac-host-");
  const otherHostDataDir = await makeTemp("sync-other-host-");

  const macHarness = experimental_createHostEntryHarness(hostEntry, {
    experimental_paths: { dataDir: macHostDataDir, tempDir: join(macHostDataDir, "tmp") },
  });
  const otherHarness = experimental_createHostEntryHarness(hostEntry, {
    experimental_paths: { dataDir: otherHostDataDir, tempDir: join(otherHostDataDir, "tmp") },
  });
  cleanup.push(() => macHarness.experimental_dispose());
  cleanup.push(() => otherHarness.experimental_dispose());

  const harnesses = new Map([
    ["host_mac", macHarness],
    ["host_other", otherHarness],
  ]);

  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-instructions",
    dataDir: serverDataDir,
    experimental_callHostRpc: (call) => {
      const target = harnesses.get(call.hostId);
      if (!target) throw new Error(`Unknown host ${call.hostId}`);
      return target.experimental_call(call.method as never, call.input as never);
    },
    sdk: {
      system: {
        config: async () => ({ primaryHostId: "host_server" }) as never,
      },
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host_server", name: "Dev PC", status: "connected" }),
          makeHostResponse({ id: "host_mac", name: "Dev Mac", status: "connected" }),
          makeHostResponse({ id: "host_other", name: "Build Linux", status: "connected" }),
        ],
      },
      providers: { list: async () => [] },
      projects: { list: async () => [] },
    },
  });
  cleanup.push(() => harness.lifecycle.dispose());
  await plugin(bb);

  const serverSourceDir = join(serverDataDir, "plugins/agent-instructions/source");
  const macMirrorDir = join(macHostDataDir, "mirror");
  const otherMirrorDir = join(otherHostDataDir, "mirror");

  return {
    bb,
    harness,
    serverDataDir,
    serverSourceDir,
    macMirrorDir,
    otherMirrorDir,
    macHarness,
    otherHarness,
  };
}

test("two-way sync propagates server edits to mirrors and mirror edits back to server, prompt, and other mirrors", async () => {
  const { harness, serverDataDir, serverSourceDir, macMirrorDir, otherMirrorDir } =
    await setupTwoHostEnv();

  // 1. Server creates doc, rule, and skill directly on disk.
  await writeText(join(serverSourceDir, "instructions/shared.md"), "Server global doc.\n");
  await writeText(
    join(serverSourceDir, "rules/r1.md"),
    "---\nname: Greeting\nenabled: true\n---\n\nRule from server.\n",
  );
  await writeText(join(serverSourceDir, "skills/alpha/SKILL.md"), skillMd("alpha", "v1\n"));

  // Sync to remote hosts.
  const synced1 = await harness.behavior.runCli(["sync"]);
  expect(synced1.exitCode).toBe(0);
  expect(await readFile(join(macMirrorDir, "instructions/shared.md"), "utf8")).toBe(
    "Server global doc.\n",
  );
  expect(await readFile(join(macMirrorDir, "skills/alpha/SKILL.md"), "utf8")).toBe(
    skillMd("alpha", "v1\n"),
  );
  expect(await readFile(join(otherMirrorDir, "rules/r1.md"), "utf8")).toContain(
    "Rule from server.",
  );

  // 2. Edit files in Dev Mac's mirror directly (ordinary file tools).
  await writeText(join(macMirrorDir, "instructions/shared.md"), "Edited on Dev Mac.\n");
  await writeText(
    join(macMirrorDir, "rules/r1.md"),
    "---\nname: Greeting\nenabled: true\n---\n\nRule edited on Dev Mac.\n",
  );
  await writeText(join(macMirrorDir, "skills/alpha/SKILL.md"), skillMd("alpha", "v2 from Mac\n"));

  // Sync pulls from Dev Mac and pushes to Build Linux.
  const synced2 = await harness.behavior.runCli(["sync"]);
  expect(synced2.exitCode).toBe(0);
  // Second sync converges Build Linux with the pulled changes.
  await harness.behavior.runCli(["sync"]);
  await harness.behavior.runCli(["publish"]);

  expect(await readFile(join(serverSourceDir, "instructions/shared.md"), "utf8")).toBe(
    "Edited on Dev Mac.\n",
  );
  expect(await readFile(join(serverDataDir, "AGENTS.md"), "utf8")).toBe("Edited on Dev Mac.\n");
  expect(await readFile(join(serverDataDir, "skills/alpha/SKILL.md"), "utf8")).toBe(
    skillMd("alpha", "v2 from Mac\n"),
  );
  expect(await readFile(join(otherMirrorDir, "skills/alpha/SKILL.md"), "utf8")).toBe(
    skillMd("alpha", "v2 from Mac\n"),
  );

  // Thread prompt receives the edited rule from Dev Mac!
  const resolved = await harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: "thr_1" },
      host: { id: "host_mac" },
      provider: { id: "codex", model: "gpt-5" },
      project: { id: "proj_1" },
    }),
  );
  expect(resolved.instructions).toBe("Rule edited on Dev Mac.");
});

test("concurrent edits on server and mirror keep a conflict copy and never publish conflicts/", async () => {
  const { harness, serverDataDir, serverSourceDir, macMirrorDir } = await setupTwoHostEnv();

  await writeText(join(serverSourceDir, "instructions/shared.md"), "Initial.\n");
  await harness.behavior.runCli(["sync"]);

  // Diverging edits on both machines!
  await writeText(join(serverSourceDir, "instructions/shared.md"), "Server edit.\n");
  await writeText(join(macMirrorDir, "instructions/shared.md"), "Mac conflicting edit.\n");

  const synced = await harness.behavior.runCli(["sync", "--json"]);
  expect(synced.exitCode).toBe(0);
  const parsed = JSON.parse(synced.stdout) as { conflicts: string[] };
  expect(parsed.conflicts).toHaveLength(1);
  expect(parsed.conflicts[0]).toMatch(/^conflicts\/dev-mac-\d{8}-\d{6}\/instructions\/shared\.md$/);

  // Server keeps its version at the canonical path and converges Mac to it.
  expect(await readFile(join(serverSourceDir, "instructions/shared.md"), "utf8")).toBe(
    "Server edit.\n",
  );
  expect(await readFile(join(macMirrorDir, "instructions/shared.md"), "utf8")).toBe(
    "Server edit.\n",
  );
  // Mac's edit is preserved losslessly in conflicts/ on BOTH server and mirror!
  expect(await readFile(join(serverSourceDir, parsed.conflicts[0]!), "utf8")).toBe(
    "Mac conflicting edit.\n",
  );
  expect(await readFile(join(macMirrorDir, parsed.conflicts[0]!), "utf8")).toBe(
    "Mac conflicting edit.\n",
  );
  // Published AGENTS.md contains ONLY the canonical doc, never the conflict file.
  await harness.behavior.runCli(["publish"]);
  expect(await readFile(join(serverDataDir, "AGENTS.md"), "utf8")).toBe("Server edit.\n");
});

test("path command returns server source on primary host and mirror dir on remote host", async () => {
  const { harness, serverSourceDir, macMirrorDir } = await setupTwoHostEnv();

  const serverPath = await harness.behavior.runCli(["path", "--host", "host_server", "--json"]);
  expect(serverPath.exitCode).toBe(0);
  expect(JSON.parse(serverPath.stdout)).toEqual({
    hostId: "host_server",
    path: serverSourceDir,
    role: "server",
  });

  const macPath = await harness.behavior.runCli(["path", "--host", "host_mac", "--json"]);
  expect(macPath.exitCode).toBe(0);
  expect(JSON.parse(macPath.stdout)).toEqual({
    hostId: "host_mac",
    path: macMirrorDir,
    role: "mirror",
  });
});

test("security: symlinks in mirror or source are never followed or exfiltrated", async () => {
  const { harness, serverSourceDir, macMirrorDir } = await setupTwoHostEnv();
  const secretDir = await makeTemp("secret-outside-");
  const secretFile = join(secretDir, "secret.txt");
  await writeFile(secretFile, "TOP_SECRET_VALUE", "utf8");

  await mkdir(join(macMirrorDir, "instructions"), { recursive: true });
  await symlink(secretFile, join(macMirrorDir, "instructions/stolen.md"));

  const synced = await harness.behavior.runCli(["sync"]);
  expect(synced.exitCode).toBe(0);
  expect(existsSync(join(serverSourceDir, "instructions/stolen.md"))).toBe(false);

  // Direct read/delete through paths.ts also refuses symlinks.
  await expect(readSyncFile(macMirrorDir, "instructions/stolen.md")).rejects.toThrow(
    SymlinkRefusedError,
  );
  await expect(deleteSyncFileAndPrune(macMirrorDir, "instructions/stolen.md")).rejects.toThrow(
    SymlinkRefusedError,
  );
});
