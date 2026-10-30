import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterAll, expect, it, vi } from "vitest";
import plugin from "../server";

// The watcher's startup and its polling pass, against a real `gh` process:
// each test points the ghPath setting at a shell script that prints what the
// real `gh` prints in that situation.
const scripts = mkdtempSync(join(tmpdir(), "slopcop-gh-"));
afterAll(() => rmSync(scripts, { recursive: true, force: true }));

const SIGNED_OUT = `To get started with GitHub CLI, please run:  gh auth login
Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.`;
const OFFLINE = `error connecting to api.github.com
check your internet connection or https://githubstatus.com`;
const NOT_A_COMMAND = `unknown command "slopcop-login" for "gh"`;
const NEEDS_CONFIGURATION =
  "`gh` is not authenticated on this machine. Run `gh auth login`, then reload the plugin.";

/** Writes a fake `gh`: `login` answers `api user`, `slopcop-login` the bot lookup, `other` the rest. */
function fakeGh(name: string, script: { login: string; slopcopLogin?: string; other?: string }) {
  const path = join(scripts, name);
  writeFileSync(
    path,
    `#!/bin/sh
case "$1 $2" in
  "api user") ${script.login} ;;
  "slopcop-login ") ${script.slopcopLogin ?? `echo '${NOT_A_COMMAND}' >&2; exit 1`} ;;
  *) ${script.other ?? "exit 0"} ;;
esac
`,
    { mode: 0o755 },
  );
  return path;
}

function startWatcher(ghPath: string) {
  const { bb, harness } = createFakePluginHost({ pluginId: "slopcop", settings: { ghPath } });
  return { bb, harness };
}

it("asks for configuration, with today's message, when gh is signed out", async () => {
  const { bb, harness } = startWatcher(
    fakeGh("signed-out", { login: `echo '${SIGNED_OUT}' >&2; exit 4` }),
  );
  try {
    await plugin(bb);
    const service = harness.behavior.runService("watcher");
    await service.done;
    expect(harness.inspection.needsConfigurationMessages).toEqual([NEEDS_CONFIGURATION]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("asks for configuration when gh fails for a reason that names neither", async () => {
  const { bb, harness } = startWatcher(join(scripts, "no-such-gh"));
  try {
    await plugin(bb);
    await harness.behavior.runService("watcher").done;
    expect(harness.inspection.needsConfigurationMessages).toEqual([NEEDS_CONFIGURATION]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("takes a bot wrapper's login when GitHub has no user for its token", async () => {
  const { bb, harness } = startWatcher(
    fakeGh("bot", {
      login: `echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; exit 1`,
      slopcopLogin: "echo 'slopcop[bot]'",
    }),
  );
  try {
    await plugin(bb);
    const service = harness.behavior.runService("watcher");
    await vi.waitFor(async () =>
      expect(await harness.behavior.callRpc("status", null)).toMatchObject({
        ghAvailable: true,
        ghLogin: "slopcop[bot]",
      }),
    );
    service.controller.abort();
    await service.done;
    expect(harness.inspection.needsConfigurationMessages).toEqual([]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("fails the watcher, so bb restarts it, when gh cannot reach GitHub", async () => {
  const { bb, harness } = startWatcher(
    fakeGh("offline", { login: `echo '${OFFLINE}' >&2; exit 1` }),
  );
  try {
    await plugin(bb);
    await expect(harness.behavior.runService("watcher").done).rejects.toThrow(
      "error connecting to api.github.com",
    );
    expect(harness.inspection.needsConfigurationMessages).toEqual([]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("stops mid-pass by killing the gh call in flight and waiting for it to exit", async () => {
  const pidFile = join(scripts, "pass.pid");
  const { bb, harness } = startWatcher(
    fakeGh("slow", {
      login: "echo slopcop-bot",
      // The PR listing hangs, as a `gh` stuck on a dead connection does.
      other: `echo $$ > '${pidFile}'; exec sleep 10`,
    }),
  );
  try {
    await plugin(bb);
    await harness.behavior.callRpc("saveRule", {
      id: null,
      rule: { name: "watch", repo: "example/example" },
    });
    const service = harness.behavior.runService("watcher");
    const pid = await vi.waitFor(() => {
      const written = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      if (!Number.isInteger(written)) throw new Error("gh has not started the PR listing yet");
      return written;
    });
    service.controller.abort();
    const stopped = await Promise.race([
      service.done.then(() => "stopped"),
      new Promise((resolve) => setTimeout(() => resolve("still polling"), 1_000)),
    ]);
    expect(stopped).toBe("stopped");
    // The stop returned only once `gh` had exited, so its process is gone.
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await harness.lifecycle.dispose();
  }
});
