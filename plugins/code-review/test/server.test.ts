import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { prKey } from "../src/shared/schema.ts";
import { baseline } from "../src/server/lib/pr-watch.ts";
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
echo "$*" >> "${join(bin, "calls")}"
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
    "landed",
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
  expect(await tools({})).toEqual([
    "code_review_share_changes",
    "code_review_watch_pr",
    "code_review_share_landed",
  ]);
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

/** The `gh` commands run so far, oldest first. */
const ghCalls = () =>
  existsSync(join(bin, "calls")) ? readFileSync(join(bin, "calls"), "utf8").trim().split("\n") : [];

/** Waits until `ready()` holds, failing after a few seconds. */
async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !ready(); i++) await Bun.sleep(10);
  expect(ready()).toBe(true);
}

/** Whether `done` settles within half a second. */
const settlesSoon = (done: Promise<void>) =>
  Promise.race([done.then(() => true), Bun.sleep(500).then(() => false)]);

/** A bb whose first `threads.get` waits for `release`, and that records what it sends and renames. */
function heldThreads() {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = { gets: 0, sent: 0, updated: 0 };
  const { bb, harness } = createFakePluginHost({
    pluginId: "code-review",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          seen.gets++;
          if (seen.gets === 1) await held;
          return makeThreadResponse({ id: threadId, status: "idle" });
        },
        send: async () => {
          seen.sent++;
          return {} as never;
        },
        update: async () => {
          seen.updated++;
          return {} as never;
        },
      },
    },
  });
  return { bb, harness, seen, release };
}

test("the pull request watch stops at once mid-poll, and nothing it started goes on", async () => {
  const { bb, harness, seen, release } = heldThreads();
  const read = {
    url: "https://github.com/cli/cli/pull/9000",
    title: "Fix auth",
    state: "open" as const,
    baseRefName: "trunk",
    mergeState: "CLEAN",
    checks: { headRefOid: "c".repeat(40), state: null, checks: [] },
    activity: [],
    pausedUntil: null,
  };
  // A watch that is due, with news the thread has not heard.
  await bb.storage.kv.set(`watch:thr_a:${prKey(REF).toLowerCase()}`, {
    ...baseline("thr_a", REF, "octocat", read, 0),
    pending: ["Comment from alice: https://github.com/cli/cli/pull/9000#c-1"],
    nextPollAt: 0,
  });
  await plugin(bb);
  const service = harness.behavior.runService("pr-watch");
  await until(() => seen.gets === 1);
  const before = ghCalls().length;

  service.controller.abort();
  const stopped = await settlesSoon(service.done);
  release();
  await Bun.sleep(300);

  expect(stopped).toBe(true);
  expect(ghCalls().slice(before)).toEqual([]);
  expect(seen.sent).toBe(0);
  await harness.lifecycle.dispose();
});

test("the landed check stops at once mid-pass, and nothing it started goes on", async () => {
  const { bb, harness, seen, release } = heldThreads();
  await bb.storage.kv.set("landed:thr_a", {
    target: { account: "octocat", prs: [REF], commits: [] },
    since: Date.now(),
  });
  await plugin(bb);
  const service = harness.behavior.runService("landed");
  await until(() => seen.gets === 1);
  const before = ghCalls().length;

  service.controller.abort();
  const stopped = await settlesSoon(service.done);
  release();
  await Bun.sleep(300);

  expect(stopped).toBe(true);
  expect(ghCalls().slice(before)).toEqual([]);
  expect(seen.updated).toBe(0);
  await harness.lifecycle.dispose();
});
