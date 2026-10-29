import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { createStore } from "../lib/db";
import { buildHeader, buildMarker } from "../lib/marker";
import plugin from "../server";

it("loads the fork with no rules and saves a disabled rule without dispatching it", async () => {
  let { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  try {
    await plugin(bb);
    expect(await harness.behavior.callRpc("listRules", null)).toEqual({ rules: [] });
    await harness.behavior.callRpc("saveRule", {
      id: null,
      rule: { name: "Fork smoke check", repo: "example/example", enabled: false },
    });
    const edited = await harness.behavior.runCli([
      "rules",
      "edit",
      "Fork smoke check",
      "--paths",
      "src/**",
      "--trigger",
      "new_issue",
    ]);
    expect(edited, edited.stderr).toMatchObject({ exitCode: 0 });
    ({ harness } = await harness.lifecycle.reload(plugin));
    expect(await harness.behavior.callRpc("listRules", null)).toMatchObject({
      rules: [
        {
          name: "Fork smoke check",
          enabled: false,
          mode: "shadow",
          triggers: ["new_issue"],
          conditions: [{ kind: "paths", globs: ["src/**"] }],
        },
      ],
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("documents compound command usage and rejects unrelated options", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  try {
    await plugin(bb);
    const help = await harness.behavior.runCli(["rules", "--help"]);
    expect(help.stdout).toContain("rules enable|disable|rm <rule>");
    const invalid = await harness.behavior.runCli(["status", "--force"]);
    expect(invalid.exitCode).not.toBe(0);
    const missing = await harness.behavior.runCli(["check", "some-rule"]);
    expect(missing.exitCode).not.toBe(0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("adds, persists, replaces and clears excluded PR authors without dropping other filters", async () => {
  let { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  try {
    await plugin(bb);
    const { rule } = await harness.behavior.callRpc("saveRule", {
      id: null,
      rule: {
        name: "Exclusions",
        repo: "example/example",
        enabled: false,
        conditions: [{ kind: "has_label", labels: ["security"] }],
      },
    });
    const edit = async (...options: string[]) => {
      const result = await harness.behavior.runCli(["rules", "edit", rule.id, ...options]);
      expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    };
    await edit("--exclude-author", "@Dana,DANA,dependabot[bot]");
    ({ harness } = await harness.lifecycle.reload(plugin));
    expect(await harness.behavior.callRpc("listRules", null)).toMatchObject({
      rules: [
        {
          conditions: [
            { kind: "has_label", labels: ["security"] },
            { kind: "exclude_author", logins: ["dana", "dependabot[bot]"] },
          ],
        },
      ],
    });
    await edit("--prompt", "Keep the exclusions.");
    expect(await harness.behavior.callRpc("listRules", null)).toMatchObject({
      rules: [
        {
          conditions: expect.arrayContaining([
            { kind: "exclude_author", logins: ["dana", "dependabot[bot]"] },
          ]),
        },
      ],
    });
    await edit("--exclude-author", "@Other");
    expect(await harness.behavior.callRpc("listRules", null)).toMatchObject({
      rules: [
        {
          conditions: [
            { kind: "has_label", labels: ["security"] },
            { kind: "exclude_author", logins: ["other"] },
          ],
        },
      ],
    });
    await edit("--exclude-author", "");
    expect(await harness.behavior.callRpc("listRules", null)).toMatchObject({
      rules: [
        {
          conditions: [{ kind: "has_label", labels: ["security"] }],
        },
      ],
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("settles cleanly finished review threads and leaves the rest open", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "slopcop",
    sdk: {
      threads: {
        get: ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            status: threadId === "thr_resumed" ? "active" : "idle",
          }),
        archive: ({ threadId }) => {
          if (threadId === "thr_throws") throw new Error("archive unavailable");
          return { archivedThreadIds: [threadId] };
        },
      },
    },
  });
  try {
    await plugin(bb);
    const store = createStore(bb.storage.database() as never);
    const start = (name: string) =>
      store.insertRun({
        id: `run_${name}`,
        ruleId: "rule_settle",
        ruleName: "settle",
        repo: "example/example",
        targetKind: "pull_request",
        prNumber: 7,
        prTitle: "Settle",
        prAuthor: "dana",
        headSha: "abc123",
        trigger: "manual",
        triggerEventId: null,
        status: "reviewing",
        mode: "shadow",
        detail: null,
        threadId: `thr_${name}`,
        commentCount: 0,
        startedAt: Date.now(),
        finishedAt: null,
      });
    const review = (name: string) =>
      `${buildHeader("summary", "settle")}\n\nLooks fine.\n\n${buildMarker({
        rule: "settle",
        run: `run_${name}`,
        sha: "abc123",
        kind: "summary",
      })}`;
    // Settings and the run row are read synchronously or in microtasks, so a
    // recorded finish also means the settle decision has read the setting.
    const finish = async (name: string, text: string | null) => {
      start(name);
      const thread = makeThreadResponse({ id: `thr_${name}` });
      await (text === null
        ? harness.behavior.emitThreadEvent("thread.failed", { thread, error: "provider error" })
        : harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: text }));
      await vi.waitFor(() => expect(store.getRun(`run_${name}`)?.finishedAt).not.toBeNull());
      return store.getRun(`run_${name}`)?.status;
    };
    const archived = () =>
      harness.sdk
        .callsTo("threads.archive")
        .map(([args]) => (args as { threadId: string }).threadId);

    expect(await finish("ok", review("ok"))).toBe("shadowed");
    await vi.waitFor(() => expect(archived()).toEqual(["thr_ok"]));

    expect(await finish("empty", "")).toBe("no_comment");
    expect(await finish("failed", null)).toBe("failed");
    expect(await finish("drift", review("someone_else"))).toBe("commented_unmarked");
    expect(await finish("resumed", review("resumed"))).toBe("shadowed");
    expect(await finish("throws", review("throws"))).toBe("shadowed");
    await harness.behavior.setSettings({ settleFinishedThreads: false });
    expect(await finish("kept", review("kept"))).toBe("shadowed");
    await harness.behavior.setSettings({ settleFinishedThreads: true });

    // A later clean run proves the earlier settle decisions have all run.
    expect(await finish("control", review("control"))).toBe("shadowed");
    await vi.waitFor(() => expect(archived()).toContain("thr_control"));
    expect(archived()).toEqual(["thr_ok", "thr_throws", "thr_control"]);
    expect(store.getRun("run_throws")?.status).toBe("shadowed");
    expect(harness.inspection.logEntries).toContainEqual({
      level: "warn",
      message: "could not settle review thread thr_throws: archive unavailable",
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});
