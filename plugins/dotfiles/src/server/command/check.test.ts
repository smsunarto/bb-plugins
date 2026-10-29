import { test } from "bun:test";
import assert from "node:assert/strict";
import { PluginCliError } from "@get-bb/plugin-sdk";

import { createFakeContext } from "../fake-context.ts";
import { cleanRepo, missingRepo } from "../fake-git.ts";
import { check } from "./check.ts";

function args(target?: string) {
  return { options: {}, positionals: { target }, passthrough: [], help: "" };
}

test("check throws when the repo is missing", async () => {
  await assert.rejects(
    () =>
      Promise.resolve(
        check(
          createFakeContext({
            inspect: async (target) => missingRepo(target),
          }),
        ).run(args(), {}),
      ),
    (error: unknown) => {
      assert.ok(error instanceof PluginCliError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.message, "dotfiles repo not found at /dotfiles on linux-builder");
      return true;
    },
  );
});

test("check without a target runs the full check task", async () => {
  const ctx = createFakeContext();
  const result = await check(ctx).run(args(), {});
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "ok",
    stderr: "host: linux-builder · repo: /dotfiles\n",
  });
  assert.deepEqual(
    ctx.git.run.mock.calls.map(([target, command]) => [target.hostId, command]),
    [["host_server", "mise run check"]],
  );
});

test("check routes each named target to its check task", async () => {
  const routes: Readonly<Record<string, string>> = {
    location: "mise run check:location",
    mise: "mise run check:mise",
    shell: "mise run check:shell",
    mcp: "mise run check:mcp",
    python: "mise run check:python",
    skills: "mise run check:skills",
    dotfiles: "mise run check:dotfiles",
    safety: "mise run check:safety",
    secrets: "mise run check:secrets",
  };
  for (const [target, command] of Object.entries(routes)) {
    const ctx = createFakeContext();
    const result = await check(ctx).run(args(target), {});
    assert.deepEqual(result, {
      exitCode: 0,
      stdout: "ok",
      stderr: "host: linux-builder · repo: /dotfiles\n",
    });
    assert.deepEqual(
      ctx.git.run.mock.calls.map(([called, calledCommand]) => [called.hostId, calledCommand]),
      [["host_server", command]],
    );
  }
});

test("check passes the task exit code and output through", async () => {
  const result = await check(
    createFakeContext({
      run: async () => ({ exitCode: 3, output: "2 failures" }),
    }),
  ).run(args("mise"), {});
  assert.deepEqual(result, {
    exitCode: 3,
    stdout: "2 failures",
    stderr: "host: linux-builder · repo: /dotfiles\n",
  });
});

test("check with an unknown target throws", async () => {
  await assert.rejects(
    () => Promise.resolve(check(createFakeContext()).run(args("nope"), {})),
    (error: unknown) => {
      assert.ok(error instanceof PluginCliError);
      assert.equal(error.exitCode, 2);
      assert.equal(error.message, "unknown check target: nope");
      return true;
    },
  );
});

test("check runs on the invoking thread's machine and names it", async () => {
  const ctx = createFakeContext({
    threadHostId: async (threadId) => (threadId === "thread-on-mac" ? "host_mac" : undefined),
    inspect: async (target) =>
      cleanRepo(target, {
        repoPath: target.hostId === "host_mac" ? "/Users/example/git/dotfiles" : "/dotfiles",
      }),
  });

  const result = await check(ctx).run(args("shell"), { threadId: "thread-on-mac" });

  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "ok",
    stderr: "host: Local Mac · repo: /Users/example/git/dotfiles\n",
  });
  assert.deepEqual(
    ctx.git.run.mock.calls.map(([called, command]) => [called.hostId, command]),
    [["host_mac", "mise run check:shell"]],
  );
});

test("check refuses an offline machine instead of reporting an empty repo", async () => {
  const ctx = createFakeContext({
    target: async () => ({ state: "offline", hostId: "host_mac", hostName: "Local Mac" }),
  });

  await assert.rejects(
    () => Promise.resolve(check(ctx).run(args(), {})),
    (error: unknown) => {
      assert.ok(error instanceof PluginCliError);
      assert.equal(error.message, "Local Mac is not connected");
      return true;
    },
  );
  assert.deepEqual(ctx.git.run.mock.calls, []);
});
