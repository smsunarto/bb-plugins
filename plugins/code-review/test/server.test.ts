import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { createStore } from "../src/server/lib/store.ts";
import plugin from "../src/server/server.ts";

/*
 * The plugin as bb loads it: its own services, the real `gh` runner (a
 * stand-in `gh` on PATH), and calls over the host's RPC, tool, and event
 * boundaries.
 */

let bin: string;
const path = process.env["PATH"];

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "code-review-gh-"));
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
if [ "$1 $2" = "auth status" ]; then
  printf 'github.com\n  \xe2\x9c\x93 Logged in to github.com account octocat (keyring)\n  - Active account: true\n'
  exit 0
fi
echo "gh: unexpected $*" >&2; exit 1
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  process.env["PATH"] = `${bin}:${path ?? ""}`;
});

afterAll(() => {
  process.env["PATH"] = path;
  rmSync(bin, { recursive: true, force: true });
});

const REF = { owner: "cli", repo: "cli", number: 9000 };

async function load() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "code-review",
    agentSkillIds: ["review", "babysit-pr"],
    sdk: {
      threads: {
        get: async ({ threadId }) => ({
          id: threadId,
          title: "Review cli/cli#9000",
          titleFallback: null,
          status: "idle",
          deletedAt: null,
        }),
      },
    },
  });
  await plugin(bb);
  return { bb, harness };
}

test("registers every RPC and answers them over the host boundary", async () => {
  const { harness } = await load();

  expect(harness.inspection.registrations.rpcMethods.toSorted()).toEqual([
    "addDraftComment",
    "agentActivity",
    "branchActivity",
    "branchReviewed",
    "changedFiles",
    "checks",
    "deleteDraft",
    "discardReview",
    "editDraft",
    "fileBlobs",
    "fixChecksPrompt",
    "inbox",
    "localBranch",
    "localBranches",
    "localChanges",
    "prAction",
    "prActionState",
    "prWatches",
    "pullRequest",
    "replyDraft",
    "reviewInstructions",
    "setBranchViewed",
    "setPinned",
    "setReviewInstructions",
    "setViewed",
    "sharedComparison",
    "startFix",
    "startLocalReview",
    "startReview",
    "status",
    "stopPrWatch",
    "submitReview",
    "unityPreview",
  ]);
  expect(await harness.behavior.callRpc("status")).toEqual({
    ok: true,
    login: "octocat",
    accounts: ["octocat"],
  });
  expect(
    await harness.behavior.callRpc("setPinned", { account: "octocat", ref: REF, pinned: true }),
  ).toEqual({ pinned: [{ ...REF, account: "octocat" }] });
  await harness.behavior.callRpc("setReviewInstructions", { instructions: "Check auth." });
  expect(await harness.behavior.callRpc("reviewInstructions")).toEqual({
    instructions: "Check auth.",
  });
  await expect(
    harness.behavior.callRpc("setPinned", { ref: { ...REF, number: -1 }, pinned: true }),
  ).rejects.toThrow();
  await harness.lifecycle.dispose();
});

test("only a review thread gets the findings tool, and its report reaches the panel", async () => {
  const { bb, harness } = await load();
  const tools = async (pluginMetadata: Record<string, string>) =>
    (
      await harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({ pluginMetadata }),
      )
    ).tools.map((tool) => tool.name);

  expect(await tools({ kind: "review", pr: "cli/cli#9000" })).toEqual([
    "code_review_report_findings",
    "code_review_share_changes",
  ]);
  expect(await tools({})).toEqual(["code_review_share_changes", "code_review_watch_pr"]);
  expect(harness.inspection.registrations.agentTools[0]?.description).toStartWith(
    "Report findings from a pull request or an unpublished branch",
  );

  await createStore(bb.storage.kv).addLink("cli/cli#9000", {
    threadId: "thr_review",
    kind: "review",
    createdAt: "2026-10-01T00:00:00.000Z",
    headRefOid: "cc36d32",
    baseRefName: "trunk",
  });
  const finding = {
    priority: 1,
    title: "Check the flag before reading it",
    body: "A nil flag panics.",
    path: "pkg/cmdutil/auth_check.go",
    line: 20,
  };
  expect(
    await harness.behavior.callAgentTool(
      "code_review_report_findings",
      { summary: "One bug.", findings: [finding] },
      { threadId: "thr_review" },
    ),
  ).toBe("Reported 1 finding on cli/cli#9000.");

  const activity = (await harness.behavior.callRpc("agentActivity", { ref: REF })) as {
    threads: { status: string }[];
    latestReview: { summary: string; findings: unknown[] };
  };
  expect(activity.threads.map((thread) => thread.status)).toEqual(["idle"]);
  expect(activity.latestReview.summary).toBe("One bug.");
  expect(activity.latestReview.findings).toEqual([
    { id: "f1", ...finding, startLine: null, side: "RIGHT" },
  ]);
  await harness.lifecycle.dispose();
});

test("a linked thread that stops working tells open panels; any other thread does not", async () => {
  const { bb, harness } = await load();
  await createStore(bb.storage.kv).addLink("cli/cli#9000", {
    threadId: "thr_fix",
    kind: "fix",
    createdAt: "2026-10-01T00:00:00.000Z",
    headRefOid: "cc36d32",
    baseRefName: "trunk",
  });

  await harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "thr_fix" }),
    lastAssistantText: null,
  });
  await harness.behavior.emitThreadEvent("thread.failed", {
    thread: makeThreadResponse({ id: "thr_fix" }),
    error: "boom",
  });
  await harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "thr_unrelated" }),
    lastAssistantText: null,
  });

  const signal = { channel: "agent-activity", payload: { key: "cli/cli#9000" } };
  expect(harness.inspection.realtimeSignals).toEqual([signal, signal]);
  await harness.lifecycle.dispose();
});
