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
import {
  deleteSyncFileAndPrune,
  readSyncFile,
  SymlinkRefusedError,
  writeSyncFileAtomic,
} from "./paths.ts";
import { syncManifestSchema } from "./host-contract.ts";

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
      subscribe: () => () => undefined,
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
  expect(parsed.conflicts[0]).toMatch(
    /^conflicts\/dev-mac-\d{8}-\d{6}-[0-9a-f]{6}\/instructions\/shared\.md$/,
  );

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

  // Direct read/write/delete through paths.ts and serverSourceDir symlink are refused.
  await expect(readSyncFile(macMirrorDir, "instructions/stolen.md")).rejects.toThrow(
    SymlinkRefusedError,
  );
  await expect(
    writeSyncFileAtomic(
      macMirrorDir,
      join(macMirrorDir, "../.tmp"),
      "instructions/stolen.md",
      Buffer.from("overwrite"),
      false,
    ),
  ).rejects.toThrow(SymlinkRefusedError);
  await expect(deleteSyncFileAndPrune(macMirrorDir, "instructions/stolen.md")).rejects.toThrow(
    SymlinkRefusedError,
  );

  // Server-side symlink is also never synced out to mirrors.
  await mkdir(join(serverSourceDir, "instructions"), { recursive: true });
  await symlink(secretFile, join(serverSourceDir, "instructions/server-link.md"));
  const syncedServer = await harness.behavior.runCli(["sync"]);
  expect(syncedServer.exitCode).toBe(0);
  expect(existsSync(join(macMirrorDir, "instructions/server-link.md"))).toBe(false);
});

test("#4: file<->directory replacements sync cleanly in both directions without ENOTDIR/EISDIR", async () => {
  const { harness, serverSourceDir, macMirrorDir } = await setupTwoHostEnv();

  await writeText(join(serverSourceDir, "skills/alpha/SKILL.md"), skillMd("alpha"));
  await writeText(join(serverSourceDir, "skills/alpha/ref"), "plain file\n");
  expect((await harness.behavior.runCli(["sync"])).exitCode).toBe(0);
  expect(await readFile(join(macMirrorDir, "skills/alpha/ref"), "utf8")).toBe("plain file\n");

  // File -> directory replacement on server
  await rm(join(serverSourceDir, "skills/alpha/ref"));
  await writeText(join(serverSourceDir, "skills/alpha/ref/guide.md"), "inside dir\n");
  expect((await harness.behavior.runCli(["sync"])).exitCode).toBe(0);
  expect(await readFile(join(macMirrorDir, "skills/alpha/ref/guide.md"), "utf8")).toBe(
    "inside dir\n",
  );

  // Directory -> file replacement on server
  await rm(join(serverSourceDir, "skills/alpha/ref"), { recursive: true, force: true });
  await writeText(join(serverSourceDir, "skills/alpha/ref"), "back to file\n");
  expect((await harness.behavior.runCli(["sync"])).exitCode).toBe(0);
  expect(await readFile(join(macMirrorDir, "skills/alpha/ref"), "utf8")).toBe("back to file\n");
});

test("#5: deleting >500 files chunks mirrorApplyOps deletes under the Zod max(500) cap", async () => {
  const { harness, serverSourceDir, macMirrorDir } = await setupTwoHostEnv();

  await writeText(join(serverSourceDir, "skills/big/SKILL.md"), skillMd("big"));
  for (let i = 0; i < 505; i++) {
    await writeText(
      join(serverSourceDir, `skills/big/files/f-${String(i).padStart(3, "0")}.txt`),
      `v${i}`,
    );
  }
  expect((await harness.behavior.runCli(["sync", "--host", "host_mac"])).exitCode).toBe(0);
  expect(existsSync(join(macMirrorDir, "skills/big/files/f-504.txt"))).toBe(true);

  await rm(join(serverSourceDir, "skills/big"), { recursive: true, force: true });
  const res = await harness.behavior.runCli(["sync", "--host", "host_mac"]);
  expect(res.exitCode).toBe(0);
  expect(existsSync(join(macMirrorDir, "skills/big/files/f-504.txt"))).toBe(false);
});

test("#6 & #28: background mirror-sync service handles mirrorChanged signals, fan-out, auto-publish, and worker exit re-watch", async () => {
  const { harness, serverDataDir, serverSourceDir, macMirrorDir, otherMirrorDir } =
    await setupTwoHostEnv();

  const service = harness.behavior.runService("mirror-sync");
  try {
    // Wait for initial startup mirrorEnsureWatch to settle.
    await writeText(join(serverSourceDir, "instructions/shared.md"), "From server.\n");
    await harness.behavior.runCli(["sync"]);

    // Edit in Mac mirror and emit mirrorChanged signal -> server pulls, auto-publishes, and fans out to Build Linux!
    await writeText(join(macMirrorDir, "instructions/shared.md"), "Live from Mac signal.\n");
    await harness.behavior.experimental_emitHostSignal("host_mac", "mirrorChanged", {
      mirrorDir: macMirrorDir,
    });

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (
        existsSync(join(serverDataDir, "AGENTS.md")) &&
        (await readFile(join(serverDataDir, "AGENTS.md"), "utf8")) === "Live from Mac signal.\n" &&
        existsSync(join(otherMirrorDir, "instructions/shared.md")) &&
        (await readFile(join(otherMirrorDir, "instructions/shared.md"), "utf8")) ===
          "Live from Mac signal.\n"
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }

    expect(await readFile(join(serverDataDir, "AGENTS.md"), "utf8")).toBe(
      "Live from Mac signal.\n",
    );
    expect(await readFile(join(otherMirrorDir, "instructions/shared.md"), "utf8")).toBe(
      "Live from Mac signal.\n",
    );

    // Emit worker exit during an active change -> must re-arm watch without throwing.
    await harness.behavior.experimental_emitHostWorkerExit("host_mac");
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    service.controller.abort();
    await service.done;
  }
});

test("#16: syncManifestSchema rejects prototype/unsafe keys and fetchHostFiles does not infinite-loop on bogus missing paths", async () => {
  expect(
    syncManifestSchema.safeParse({
      toString: { sha256: "a".repeat(64), executable: false, size: 1 },
    }).success,
  ).toBe(false);
  expect(
    syncManifestSchema.safeParse({
      "../escape.md": { sha256: "a".repeat(64), executable: false, size: 1 },
    }).success,
  ).toBe(false);

  const serverDataDir = await makeTemp("sync-16-server-");
  let readCalls = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-instructions",
    dataDir: serverDataDir,
    experimental_callHostRpc: async (call) => {
      if (call.method === "mirrorEnsureWatch" || call.method === "mirrorSnapshot") {
        return {
          mirrorDir: "/fake/mirror",
          manifest: {
            "instructions/a.md": { sha256: "a".repeat(64), executable: false, size: 5 },
          },
          symlinks: [],
          tooLarge: [],
          truncated: false,
        };
      }
      if (call.method === "mirrorReadFiles") {
        readCalls++;
        // Malicious/buggy host returns unrelated missing path instead of requested path.
        return { files: [], missing: ["instructions/other.md"] };
      }
      return { applied: [], conflicts: [], manifest: {} };
    },
    sdk: {
      subscribe: () => () => undefined,
      system: { config: async () => ({ primaryHostId: "host_server" }) as never },
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host_server", name: "Server", status: "connected" }),
          makeHostResponse({ id: "host_bad", name: "Bad Host", status: "connected" }),
        ],
      },
      providers: { list: async () => [] },
      projects: { list: async () => [] },
    },
  });
  cleanup.push(() => harness.lifecycle.dispose());
  await plugin(bb);

  const res = await harness.behavior.runCli(["sync", "--host", "host_bad"]);
  expect(res.exitCode).toBe(0);
  // Broke out after 1 non-progressing batch instead of spinning forever.
  expect(readCalls).toBe(1);
});

test("#31 & #32: sync --host scopes to one host and non-parsed files sync across hosts", async () => {
  const { harness, serverSourceDir, macMirrorDir, otherMirrorDir } = await setupTwoHostEnv();
  await writeText(join(serverSourceDir, "instructions/notes.txt"), "non-md synced note\n");

  const macOnly = await harness.behavior.runCli(["sync", "--host", "host_mac"]);
  expect(macOnly.exitCode).toBe(0);
  expect(await readFile(join(macMirrorDir, "instructions/notes.txt"), "utf8")).toBe(
    "non-md synced note\n",
  );
  // Build Linux was NOT synced when --host host_mac was passed!
  expect(existsSync(join(otherMirrorDir, "instructions/notes.txt"))).toBe(false);
});
