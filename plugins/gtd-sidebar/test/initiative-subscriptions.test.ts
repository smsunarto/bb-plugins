// Behavior tests for the initiative subscription runtime. Every test drives
// the real store + engine against an in-memory SQLite database and fake
// threads/host/fetch — no stubs inside the unit under test.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Database } from "bun:sqlite";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import {
  createSubscriptionEngine,
  createSubscriptionStore,
  INITIATIVE_SUBSCRIPTION_MIGRATIONS,
  initialCursorFor,
  parseSlackCursor,
  parseSubscriptionConfig,
  registerInitiativeSubscriptions,
  serializeSlackCursor,
  type GitHubCiRun,
  type GitHubPrSnapshot,
  type SlackMessage,
  type SubscriptionEngineDeps,
} from "../lib/initiative-subscriptions.ts";
import { execGitHubCiRuns, execGitHubPrActivity, type GhExec } from "../lib/github-host.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const SLACK_TOKEN = "xoxb-test";

function makeDb(): BetterSqliteDatabase {
  // bun:sqlite is API-compatible with the better-sqlite3 surface the store
  // uses (prepare/run/get/all/exec/transaction) — same shape BB hands the
  // plugin via bb.storage.database().
  const db = new Database(":memory:");
  for (const statement of INITIATIVE_SUBSCRIPTION_MIGRATIONS) db.exec(statement);
  return db as unknown as BetterSqliteDatabase;
}

interface SentMessage {
  threadId: string;
  text: string;
}

interface SlackPage {
  messages?: SlackMessage[];
  has_more?: boolean;
  next_cursor?: string;
  error?: string;
  /** Simulate an HTTP 429 with a Retry-After header (seconds). */
  status429?: number;
}

interface HarnessOptions {
  enabled?: () => boolean;
  active?: () => boolean;
  coordinatorId?: string | null;
  thread?: { archivedAt: number | null; deletedAt: number | null };
  slackToken?: string;
  /**
   * Slack fixture: either a queue of pages consumed in order, or a function
   * evaluated per request (may return a promise — used for in-flight control).
   */
  slack?: SlackPage[] | ((url: URL) => SlackPage | Promise<SlackPage>);
  host?: Record<string, unknown> | ((method: string) => unknown | Promise<unknown>);
  now?: () => number;
  maxEventsPerDigest?: number;
  sendError?: Error;
}

function slackResponse(page: SlackPage): Response {
  if (page.status429 !== undefined) {
    return new Response("rate limited", {
      status: 429,
      headers: { "retry-after": String(page.status429) },
    });
  }
  return new Response(
    JSON.stringify({
      ok: page.error === undefined,
      error: page.error,
      messages: page.messages ?? [],
      has_more: page.has_more ?? false,
      response_metadata: page.next_cursor ? { next_cursor: page.next_cursor } : undefined,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeHarness(options: HarnessOptions = {}) {
  const db = makeDb();
  const store = createSubscriptionStore(db);
  const sent: SentMessage[] = [];
  const slackRequests: URL[] = [];
  const published: unknown[] = [];
  let slackPageIndex = 0;

  const deps: SubscriptionEngineDeps = {
    isEnabled: () => options.enabled?.() ?? true,
    store,
    getCoordinatorThreadId: async () =>
      options.coordinatorId === undefined ? "thr_coord" : options.coordinatorId,
    isInitiativeActive: () => options.active?.() ?? true,
    threads: {
      get: async () => options.thread ?? { archivedAt: null, deletedAt: null },
      send: async ({ threadId, input }) => {
        if (options.sendError) throw options.sendError;
        sent.push({ threadId, text: input[0]?.text ?? "" });
        return {};
      },
    },
    environments: {
      get: async () => ({ hostId: "host_1", path: "/checkout/repo" }),
    },
    host: {
      call: async (method) => {
        const fixture = options.host;
        if (typeof fixture === "function") return fixture(method);
        return fixture?.[method] ?? { ok: false, error: `no fixture for ${String(method)}` };
      },
    },
    getSlackToken: async () => options.slackToken,
    publish: (_channel, payload) => published.push(payload),
    log: { info() {}, warn() {}, error() {} },
    now: options.now ?? (() => T0),
    maxEventsPerDigest: options.maxEventsPerDigest,
    deliveryRetryBaseMs: 1_000,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      slackRequests.push(url);
      const fixture = options.slack;
      if (typeof fixture === "function") return slackResponse(await fixture(url));
      const page = fixture?.[slackPageIndex++] ?? {};
      return slackResponse(page);
    }) as typeof fetch,
  };

  const engine = createSubscriptionEngine(deps);
  return { db, store, engine, sent, slackRequests, published };
}

const msg = (
  ts: string,
  text = `message ${ts}`,
  extra: Partial<SlackMessage> = {},
): SlackMessage => ({
  ts,
  user: "U123",
  text,
  ...extra,
});

const ciRun = (overrides: Partial<GitHubCiRun> = {}): GitHubCiRun => ({
  databaseId: 100,
  attempt: 1,
  name: "CI",
  displayTitle: "build",
  status: "completed",
  conclusion: "success",
  event: "push",
  headBranch: "main",
  url: "https://github.com/o/r/actions/runs/100",
  updatedAt: new Date(T0).toISOString(),
  ...overrides,
});

const slackConfig = { channelId: "C123" };
const ciConfig = { repo: "o/r", environmentId: "env_1" };

// ---------------------------------------------------------------------------
// Contract: label + prompt + discriminated kind/config validation
// ---------------------------------------------------------------------------

describe("subscription contract", () => {
  it("persists label and prompt and round-trips them", () => {
    const { store } = makeHarness();
    store.create({
      id: "s1",
      initiativeId: "i1",
      kind: "github-ci",
      label: "CI on main",
      prompt: "Triage the failure and propose a fix.",
      config: ciConfig,
      now: T0,
    });
    const read = store.get("s1")!;
    assert.equal(read.label, "CI on main");
    assert.equal(read.prompt, "Triage the failure and propose a fix.");
    assert.deepEqual(
      store.list("i1").map((s) => s.id),
      ["s1"],
    );
  });

  it("rejects empty labels and mismatched kind/config pairs", () => {
    const { store } = makeHarness();
    assert.throws(
      () =>
        store.create({
          id: "s1",
          initiativeId: "i1",
          kind: "github-ci",
          label: "   ",
          config: ciConfig,
        }),
      /label is required/,
    );
    assert.throws(
      () => parseSubscriptionConfig("github-ci", { channelId: "C1" }),
      /Invalid github-ci/,
    );
    assert.throws(() => parseSubscriptionConfig("schedule", { repo: "o/r" }), /Invalid schedule/);
    assert.throws(() => parseSubscriptionConfig("slack-channel", {}), /Invalid slack-channel/);
    assert.throws(
      () =>
        parseSubscriptionConfig("schedule", {
          schedule: "cron",
          expression: "definitely not cron",
          prompt: "x",
        }),
      /Invalid schedule config/,
    );
  });

  it("surfaces a corrupt stored row as invalid_config instead of throwing", async () => {
    const { db, store, engine, sent } = makeHarness();
    store.create({
      id: "s1",
      initiativeId: "i1",
      kind: "slack-channel",
      label: "chan",
      config: slackConfig,
      initialCursor: null,
      now: T0,
    });
    db.exec(
      `UPDATE initiative_subscriptions SET config = '{not json', next_run_at = ${T0} WHERE id = 's1'`,
    );
    const corrupt = store.get("s1")!;
    assert.equal(corrupt.config, null);
    assert.match(corrupt.configError ?? "", /JSON|invalid/i);
    await engine.runNow("s1");
    const after = store.get("s1")!;
    assert.equal(after.lastStatus, "invalid_config");
    assert.equal(after.nextRunAt, null); // parked, not retried forever
    assert.equal(sent.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Schedule kind
// ---------------------------------------------------------------------------

describe("schedule subscriptions", () => {
  it("fires a due cron expression and re-arms at the next occurrence", async () => {
    let nowValue = T0;
    const { store, engine, sent } = makeHarness({ now: () => nowValue });
    const sub = store.create({
      id: "s1",
      initiativeId: "i1",
      kind: "schedule",
      label: "standup",
      config: { schedule: "cron", expression: "* * * * *", prompt: "Post the standup." },
      now: T0 - 120_000,
    });
    assert.ok(sub.nextRunAt !== null && sub.nextRunAt <= T0);
    await engine.runNow("s1");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.text, "Post the standup.");
    const after = store.get("s1")!;
    assert.ok(after.nextRunAt !== null && after.nextRunAt > T0);
    nowValue = after.nextRunAt;
    await engine.runNow("s1");
    assert.equal(sent.length, 2);
  });

  it("a due one-shot survives a pause and fires exactly once after restore", async () => {
    let active = false;
    let nowValue = T0;
    const { store, engine, sent } = makeHarness({
      active: () => active,
      now: () => nowValue,
    });
    const sub = store.create({
      id: "once1",
      initiativeId: "i1",
      kind: "schedule",
      label: "one shot",
      config: { schedule: "once", runAt: T0 - 1, prompt: "fire once" },
      now: T0 - 60_000,
    });
    for (let i = 0; i < 3; i++) {
      nowValue = T0 + i * 1_000;
      await engine.sweep();
      assert.equal(sent.length, 0);
      assert.equal(store.get("once1")!.nextRunAt, sub.nextRunAt); // pending send preserved
      assert.equal(store.get("once1")!.enabled, true);
    }
    active = true;
    nowValue = T0 + 5_000;
    await engine.sweep();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.text, "fire once");
    const after = store.get("once1")!;
    assert.equal(after.enabled, false);
    assert.equal(after.nextRunAt, null);
    await engine.sweep();
    assert.equal(sent.length, 1); // never refires
  });
});

// ---------------------------------------------------------------------------
// GitHub kind: baseline, dedupe, rerun identity, errors
// ---------------------------------------------------------------------------

describe("github subscriptions", () => {
  it("baselines existing runs silently, then delivers new completions", async () => {
    let runs: GitHubCiRun[] = [ciRun({ databaseId: 1 })];
    const { store, engine, sent } = makeHarness({
      host: () => ({ ok: true, runs }),
    });
    store.create({
      id: "s1",
      initiativeId: "i1",
      kind: "github-ci",
      label: "CI",
      config: ciConfig,
      initialCursor: null,
      now: T0,
    });
    await engine.runNow("s1");
    assert.equal(sent.length, 0);
    assert.equal(store.get("s1")!.lastStatus, "baseline");
    runs = [ciRun({ databaseId: 2 }), ciRun({ databaseId: 1 })];
    await engine.runNow("s1");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /success · CI on main/);
    await engine.runNow("s1");
    assert.equal(sent.length, 1); // deduped
  });

  it("delivers a failed run and its successful rerun as separate events", async () => {
    let runs: GitHubCiRun[] = [ciRun({ databaseId: 7, attempt: 1, conclusion: "failure" })];
    const { store, engine, sent } = makeHarness({ host: () => ({ ok: true, runs }) });
    store.create({
      id: "s1",
      initiativeId: "i1",
      kind: "github-ci",
      label: "CI",
      config: { ...ciConfig, catchUp: true },
      initialCursor: "0",
      now: T0,
    });
    await engine.runNow("s1");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /failure/);
    runs = [ciRun({ databaseId: 7, attempt: 2, conclusion: "success" })];
    await engine.runNow("s1");
    assert.equal(sent.length, 2);
    assert.match(sent[1]!.text, /success/);
    await engine.runNow("s1");
    assert.equal(sent.length, 2); // deduped
  });

  it("delivers PR comments and reviews once, wrapped in label + prompt", async () => {
    const snapshot: GitHubPrSnapshot = {
      number: 42,
      title: "t",
      url: "u",
      state: "OPEN",
      mergedAt: null,
      comments: [
        {
          id: "c1",
          author: { login: "ada" },
          body: "please fix",
          createdAt: new Date(T0).toISOString(),
        },
      ],
      reviews: [
        {
          id: "r1",
          author: { login: "grace" },
          body: "lgtm",
          state: "APPROVED",
          submittedAt: new Date(T0).toISOString(),
        },
      ],
      reviewComments: [
        {
          id: "rc1",
          author: { login: "hopper" },
          body: "off-by-one here",
          createdAt: new Date(T0).toISOString(),
          path: "src/index.ts",
          line: 12,
          inReplyToId: null,
        },
      ],
    };
    const { store, engine, sent } = makeHarness({
      host: { githubPrActivity: { ok: true, snapshot } },
    });
    store.create({
      id: "s1",
      initiativeId: "i1",
      kind: "github-pr",
      label: "PR 42",
      prompt: "Summarize review feedback.",
      config: { repo: "o/r", pr: 42, environmentId: "env_1", catchUp: true },
      initialCursor: "0",
      now: T0,
    });
    await engine.runNow("s1");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /PR 42/); // record label heads the digest
    assert.match(sent[0]!.text, /Summarize review feedback/); // record prompt wraps it
    assert.match(sent[0]!.text, /ada commented/);
    assert.match(sent[0]!.text, /grace reviewed \(approved\)/);
    assert.match(sent[0]!.text, /hopper commented on src\/index\.ts:12/);
    await engine.runNow("s1");
    assert.equal(sent.length, 1); // dedupe: no second digest
  });

  it("surfaces host failures as subscription errors, not crashes", async () => {
    const { store, engine, sent } = makeHarness({
      host: { githubCiRuns: { ok: false, error: "gh CLI not found on this host" } },
    });
    store.create({
      id: "s1",
      initiativeId: "i1",
      kind: "github-ci",
      label: "CI",
      config: { ...ciConfig, catchUp: true },
      initialCursor: "0",
      now: T0,
    });
    await engine.runNow("s1");
    const after = store.get("s1")!;
    assert.equal(after.lastStatus, "error");
    assert.match(after.lastError ?? "", /gh CLI not found/);
    assert.equal(sent.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Slack kind: backlog, pagination, rate limits, lifecycle
// ---------------------------------------------------------------------------

function createSlack(harness: ReturnType<typeof makeHarness>, id = "s1") {
  return harness.engine.createSubscription({
    id,
    initiativeId: "i1",
    kind: "slack-channel",
    label: "team channel",
    config: slackConfig,
    now: T0,
  });
}

describe("slack subscriptions", () => {
  it("stamps a new subscription at creation time; catchUp starts at 0", () => {
    const { engine } = makeHarness({ slackToken: SLACK_TOKEN });
    const sub = createSlack({ engine } as ReturnType<typeof makeHarness>);
    assert.equal(parseSlackCursor(sub.cursor).watermark, (T0 / 1000).toFixed(6));
    const catchUp = initialCursorFor("slack-channel", { ...slackConfig, catchUp: true }, T0);
    assert.equal(parseSlackCursor(catchUp).watermark, "0");
  });

  it("reports missing configuration honestly and keeps polling later", async () => {
    const { store, engine, sent } = makeHarness({ slackToken: undefined });
    createSlack({ engine } as ReturnType<typeof makeHarness>);
    await engine.runNow("s1");
    const after = store.get("s1")!;
    assert.equal(after.lastStatus, "error");
    assert.match(after.lastError ?? "", /slack-not-configured/);
    assert.ok(after.nextRunAt !== null);
    assert.equal(sent.length, 0);
  });

  it("delivers messages across multiple history pages without loss", async () => {
    const { store, engine, sent, slackRequests } = makeHarness({
      slackToken: SLACK_TOKEN,
      slack: [
        {
          messages: [msg("3.0", "third"), msg("2.0", "second")],
          has_more: true,
          next_cursor: "p2",
        },
        { messages: [msg("1.0", "first")] },
      ],
      maxEventsPerDigest: 50,
    });
    createSlack({ engine } as ReturnType<typeof makeHarness>);
    await engine.runNow("s1");
    assert.equal(sent.length, 1);
    // Oldest-first ordering inside the digest.
    const first = sent[0]!.text.indexOf("first");
    const third = sent[0]!.text.indexOf("third");
    assert.ok(first !== -1 && third !== -1 && first < third);
    assert.equal(slackRequests.length, 2);
    assert.equal(slackRequests[1]!.searchParams.get("cursor"), "p2");
    // Watermark advanced to the newest covered ts.
    assert.equal(parseSlackCursor(store.get("s1")!.cursor).watermark, "3.0");
    await engine.runNow("s1");
    assert.equal(sent.length, 1); // nothing new — dedupe + watermark
  });

  it("drains a >maxEvents backlog across sweeps with no loss", async () => {
    const events = Array.from({ length: 7 }, (_, i) => msg(`${10 - i}.0`, `m${10 - i}`));
    const { engine, sent } = makeHarness({
      slackToken: SLACK_TOKEN,
      slack: [{ messages: events }],
      maxEventsPerDigest: 3,
    });
    createSlack({ engine } as ReturnType<typeof makeHarness>);
    await engine.runNow("s1");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /\+4 more, delivered on the next check/);
    assert.match(sent[0]!.text, /m4/); // oldest first
    await engine.runNow("s1");
    assert.equal(sent.length, 2);
    await engine.runNow("s1");
    assert.equal(sent.length, 3);
    const delivered = sent.flatMap((s) => [...s.text.matchAll(/: m(\d+)/g)].map((m) => m[1]));
    assert.equal(delivered.length, 7);
    assert.deepEqual([...delivered].sort(), ["10", "4", "5", "6", "7", "8", "9"]);
  });

  it("resumes a truncated scan from the page cursor, not page 1", async () => {
    // 8 pages (> SLACK_MAX_HISTORY_PAGES=5): the scan must suspend and resume.
    const pages: SlackPage[] = Array.from({ length: 8 }, (_, i) => ({
      messages: [msg(`${8 - i}.0`, `page${i}`)],
      has_more: i < 7,
      next_cursor: i < 7 ? `pc${i + 1}` : undefined,
    }));
    const requestedCursors: (string | null)[] = [];
    const { engine, sent } = makeHarness({
      slackToken: SLACK_TOKEN,
      maxEventsPerDigest: 50,
      slack: (url) => {
        requestedCursors.push(url.searchParams.get("cursor"));
        // Page index = number of requests so far (minus 1 for this call).
        return pages[requestedCursors.length - 1] ?? { messages: [] };
      },
    });
    createSlack({ engine } as ReturnType<typeof makeHarness>);
    await engine.runNow("s1");
    assert.equal(requestedCursors.length, 5); // page budget hit
    assert.deepEqual(requestedCursors, [null, "pc1", "pc2", "pc3", "pc4"]);
    await engine.runNow("s1"); // resumes at pc5 — never re-fetches page 1
    assert.deepEqual(requestedCursors.slice(5), ["pc5", "pc6", "pc7"]);
    const text = sent.map((s) => s.text).join("\n");
    for (let i = 0; i < 8; i++) assert.match(text, new RegExp(`page${i}`));
  });

  it("honors 429 Retry-After and resumes the in-flight scan afterwards", async () => {
    let calls = 0;
    let nowValue = T0;
    const { store, engine, sent } = makeHarness({
      slackToken: SLACK_TOKEN,
      now: () => nowValue,
      slack: () => {
        calls += 1;
        if (calls === 2) return { status429: 45 };
        if (calls === 1) return { messages: [msg("5.0", "p1")], has_more: true, next_cursor: "p2" };
        return { messages: [msg("4.0", "p2")] };
      },
    });
    createSlack({ engine } as ReturnType<typeof makeHarness>);
    await engine.runNow("s1");
    const after = store.get("s1")!;
    assert.equal(after.lastStatus, "rate_limited");
    assert.equal(after.retryAfterUntil, T0 + 45_000);
    assert.equal(after.nextRunAt, T0 + 45_000);
    // While backing off, a sweep does not call slack again.
    await engine.sweep();
    assert.equal(calls, 2);
    // The scan's page cursor was persisted — the retry resumes at p2.
    nowValue = T0 + 46_000;
    await engine.runNow("s1");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /p1/);
    assert.match(sent[0]!.text, /p2/);
  });

  it("shrinks the page request to remaining backlog capacity — no mid-page drops", async () => {
    // Preload a nearly-full backlog (cap 200): room = 3, so limit must be 3.
    const pending = Array.from({ length: 197 }, (_, i) => ({
      eventId: `slack-C123-old${i}`,
      ts: `old${i}`,
      occurredAt: i,
      text: `old${i}`,
    }));
    const limits: (string | null)[] = [];
    const { store, engine } = makeHarness({
      slackToken: SLACK_TOKEN,
      slack: (url) => {
        limits.push(url.searchParams.get("limit"));
        return {
          messages: [msg("1.0", "a"), msg("2.0", "b"), msg("3.0", "c")],
          has_more: true,
          next_cursor: "more",
        };
      },
      maxEventsPerDigest: 0, // drain nothing — backlog stays full
    });
    const sub = createSlack({ engine } as ReturnType<typeof makeHarness>);
    const state = parseSlackCursor(sub.cursor);
    state.pending = pending;
    store.saveCursor(sub.id, serializeSlackCursor(state), T0);
    await engine.runNow("s1");
    assert.equal(limits[0], "3");
    // The 3 fetched events were enqueued; nothing dropped, nothing past room.
    const after = parseSlackCursor(store.get("s1")!.cursor);
    assert.equal(after.pending.length, 200);
  });

  it("does not send when disabled or deleted mid-poll", async () => {
    for (const mode of ["disable", "delete"] as const) {
      const harness = makeHarness({
        slackToken: SLACK_TOKEN,
        slack: () => {
          if (mode === "disable") harness.store.setEnabled("s1", false, T0);
          else harness.store.remove("s1");
          return { messages: [msg("1.0", "late")] };
        },
      });
      createSlack(harness);
      await harness.engine.runNow("s1");
      assert.equal(harness.sent.length, 0, mode);
      if (mode === "disable") {
        // Fetched progress was persisted — nothing lost on re-enable.
        const state = parseSlackCursor(harness.store.get("s1")!.cursor);
        assert.equal(state.pending.length, 1);
      }
    }
  });

  it("does not send or commit after dispose during an in-flight fetch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const harness = makeHarness({
      slackToken: SLACK_TOKEN,
      slack: async () => {
        await gate;
        return { messages: [msg("1.0", "late")] };
      },
    });
    createSlack(harness);
    const running = harness.engine.runNow("s1");
    await new Promise((r) => setTimeout(r, 10)); // let the fetch start
    harness.engine.dispose();
    release();
    await running;
    assert.equal(harness.sent.length, 0);
    assert.equal(harness.store.get("s1")!.lastStatus, null); // nothing recorded
  });

  it("runNow during an in-flight run shares the claim — one send", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const harness = makeHarness({
      slackToken: SLACK_TOKEN,
      slack: async () => {
        await gate;
        return { messages: [msg("1.0", "hi")] };
      },
    });
    createSlack(harness);
    const first = harness.engine.runNow("s1");
    await new Promise((r) => setTimeout(r, 10));
    const second = await harness.engine.runNow("s1");
    assert.equal(second, "in-flight");
    release();
    assert.equal(await first, "ran");
    assert.equal(harness.sent.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: inactive initiatives, archived coordinators, delivery retries
// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  it("skips polls while the initiative is archived without sending", async () => {
    let active = false;
    const { store, engine, sent, slackRequests } = makeHarness({
      active: () => active,
      slackToken: SLACK_TOKEN,
      slack: [{ messages: [msg("1.0")] }],
    });
    createSlack({ engine } as ReturnType<typeof makeHarness>);
    await engine.runNow("s1");
    assert.equal(slackRequests.length, 0); // never fetched
    assert.equal(sent.length, 0);
    assert.equal(store.get("s1")!.lastStatus, "quiet");
    active = true;
    await engine.runNow("s1");
    assert.equal(sent.length, 1);
  });

  it("reports an archived coordinator thread as a delivery error", async () => {
    const { store, engine, sent } = makeHarness({
      slackToken: SLACK_TOKEN,
      thread: { archivedAt: T0, deletedAt: null },
      slack: [{ messages: [msg("1.0")] }],
    });
    createSlack({ engine } as ReturnType<typeof makeHarness>);
    await engine.runNow("s1");
    assert.equal(sent.length, 0);
    const after = store.get("s1")!;
    assert.equal(after.lastStatus, "delivery_error");
    assert.match(after.lastError ?? "", /archived/);
    // Backlog retained: the message is pending, not dropped.
    assert.equal(parseSlackCursor(after.cursor).pending.length, 1);
  });

  it("retries delivery after a send failure without losing or duplicating", async () => {
    let fail = true;
    const sent: SentMessage[] = [];
    const db = makeDb();
    const store = createSubscriptionStore(db);
    const engine = createSubscriptionEngine({
      isEnabled: () => true,
      store,
      getCoordinatorThreadId: async () => "thr_coord",
      isInitiativeActive: () => true,
      threads: {
        get: async () => ({ archivedAt: null, deletedAt: null }),
        send: async ({ threadId, input }) => {
          if (fail) throw new Error("dispatch rejected");
          sent.push({ threadId, text: input[0]?.text ?? "" });
          return {};
        },
      },
      environments: { get: async () => ({ hostId: "h", path: "/x" }) },
      host: { call: async () => ({ ok: false, error: "unused" }) },
      getSlackToken: async () => SLACK_TOKEN,
      publish: () => {},
      log: { info() {}, warn() {}, error() {} },
      now: () => T0,
      deliveryRetryBaseMs: 1_000,
      fetchImpl: (async () => slackResponse({ messages: [msg("1.0", "hello")] })) as typeof fetch,
    });
    engine.createSubscription({
      id: "s1",
      initiativeId: "i1",
      kind: "slack-channel",
      label: "chan",
      config: slackConfig,
      now: T0,
    });
    await engine.runNow("s1");
    assert.equal(sent.length, 0);
    assert.equal(store.get("s1")!.lastStatus, "delivery_error");
    fail = false;
    await engine.runNow("s1");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /hello/);
    await engine.runNow("s1");
    assert.equal(sent.length, 1); // delivered once, never duplicated
  });
});

// ---------------------------------------------------------------------------
// Realtime notifications — every mutation path must publish so open Listening
// trays refresh; a silent create/update/delete leaves stale UI forever.
// ---------------------------------------------------------------------------

describe("realtime notifications", () => {
  const onceConfig = { schedule: "once" as const, runAt: T0 + 60_000, prompt: "go" };

  it("publishes on create — including a disabled create", () => {
    const { engine, published } = makeHarness();
    const a = engine.upsertSubscription({
      initiativeId: "i1",
      kind: "schedule",
      label: "a",
      config: onceConfig,
    });
    assert.equal(published.length, 1);
    assert.deepEqual(published[0], { subscriptionId: a.id });
    published.length = 0;
    const b = engine.upsertSubscription({
      initiativeId: "i1",
      kind: "schedule",
      label: "b",
      config: onceConfig,
      enabled: false,
    });
    assert.equal(published.length, 1);
    assert.deepEqual(published[0], { subscriptionId: b.id });
  });

  it("publishes on update, delete, and initiative teardown", () => {
    const { engine, published, store } = makeHarness();
    const a = engine.upsertSubscription({
      initiativeId: "i1",
      kind: "schedule",
      label: "a",
      config: onceConfig,
    });
    const b = engine.upsertSubscription({
      initiativeId: "i1",
      kind: "schedule",
      label: "b",
      config: onceConfig,
    });
    published.length = 0;
    engine.upsertSubscription({
      subscriptionId: a.id,
      initiativeId: "i1",
      kind: "schedule",
      label: "renamed",
      config: onceConfig,
    });
    assert.deepEqual(published, [{ subscriptionId: a.id }]);
    published.length = 0;
    engine.deleteSubscription(a.id);
    assert.deepEqual(published, [{ subscriptionId: a.id }]);
    assert.equal(store.get(a.id), null);
    published.length = 0;
    engine.removeForInitiative("i1");
    assert.deepEqual(published, [{ subscriptionId: b.id }]);
  });

  it("delete mid-poll prevents the send", async () => {
    let resolveFetch: (page: SlackPage) => void = () => {};
    let markStarted: () => void = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { engine, sent, store } = makeHarness({
      slackToken: SLACK_TOKEN,
      slack: () => {
        markStarted();
        return new Promise<SlackPage>((resolve) => {
          resolveFetch = resolve;
        });
      },
    });
    const sub = engine.upsertSubscription({
      initiativeId: "i1",
      kind: "slack-channel",
      label: "chan",
      config: { channelId: "C1", catchUp: true },
    });
    const run = engine.runNow(sub.id);
    await fetchStarted; // the Slack fetch is now genuinely in flight
    engine.deleteSubscription(sub.id);
    resolveFetch({ messages: [msg("1000.1", "late hello")] });
    await run;
    assert.equal(sent.length, 0);
    assert.equal(store.get(sub.id), null);
  });
});

// ---------------------------------------------------------------------------
// Config-change staleness — repointing a watch mid-poll must not let the old
// source's run deliver or commit cursor into the reconfigured row; material
// changes re-baseline, presentation-only edits keep progress.
// ---------------------------------------------------------------------------

describe("config-change staleness", () => {
  it("a source change mid-poll drops the stale run and keeps the new baseline", async () => {
    let resolveFetch: (page: SlackPage) => void = () => {};
    let markStarted: () => void = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { engine, sent, store } = makeHarness({
      slackToken: SLACK_TOKEN,
      slack: () => {
        markStarted();
        return new Promise<SlackPage>((resolve) => {
          resolveFetch = resolve;
        });
      },
    });
    const sub = engine.upsertSubscription({
      initiativeId: "i1",
      kind: "slack-channel",
      label: "chan",
      config: { channelId: "C1", catchUp: true },
    });
    const run = engine.runNow(sub.id);
    await fetchStarted;
    // Repoint the watch at a different channel while C1's fetch is in flight.
    engine.upsertSubscription({
      subscriptionId: sub.id,
      initiativeId: "i1",
      kind: "slack-channel",
      label: "chan",
      config: { channelId: "C2" },
    });
    const baselineCursor = store.get(sub.id)!.cursor; // new source's baseline
    resolveFetch({ messages: [msg("1000.1", "old channel news")] });
    await run;
    assert.equal(sent.length, 0); // old-source events never deliver
    assert.equal(store.get(sub.id)!.cursor, baselineCursor); // baseline not clobbered
  });

  it("material config change resets progress; label-only edit keeps it", async () => {
    const { engine, store } = makeHarness({
      slackToken: SLACK_TOKEN,
      slack: [{ messages: [msg("9.5", "hi")] }],
    });
    const sub = engine.upsertSubscription({
      initiativeId: "i1",
      kind: "slack-channel",
      label: "chan",
      config: { channelId: "C1", catchUp: true },
    });
    await engine.runNow(sub.id);
    const progressCursor = store.get(sub.id)!.cursor;
    assert.equal(store.deliveredEventIds(sub.id).size, 1);

    // Label-only edit: same canonical config → cursor and dedupe retained.
    engine.upsertSubscription({
      subscriptionId: sub.id,
      initiativeId: "i1",
      kind: "slack-channel",
      label: "renamed",
      config: { channelId: "C1", catchUp: true },
    });
    assert.equal(store.get(sub.id)!.cursor, progressCursor);
    assert.equal(store.deliveredEventIds(sub.id).size, 1);

    // Material change: dedupe cleared, cursor re-baselined for the new source.
    engine.upsertSubscription({
      subscriptionId: sub.id,
      initiativeId: "i1",
      kind: "slack-channel",
      label: "renamed",
      config: { channelId: "C2" },
    });
    assert.equal(store.deliveredEventIds(sub.id).size, 0);
    assert.notEqual(store.get(sub.id)!.cursor, progressCursor);
  });
});

// ---------------------------------------------------------------------------
// GitHub host bridge — pagination and REST normalization, driven through the
// injected exec seam (no real gh binary involved).
// ---------------------------------------------------------------------------

describe("github host bridge", () => {
  const NOW = Date.parse("2026-01-10T00:00:00Z");
  const RECENT = new Date(NOW - 60_000).toISOString();
  const signal = new AbortController().signal;

  function fakeExec(respond: (key: string) => unknown) {
    const calls: string[] = [];
    const exec: GhExec = async (_file, args) => {
      const key = args.join(" ");
      calls.push(key);
      const out = respond(key);
      if (out === undefined) throw new Error(`unexpected gh call: ${key}`);
      return { stdout: JSON.stringify(out), stderr: "" };
    };
    return { exec, calls };
  }

  function restRun(id: number, overrides: Record<string, unknown> = {}) {
    return {
      id,
      run_attempt: 1,
      name: "CI",
      display_title: `run ${id}`,
      status: "completed",
      conclusion: "success",
      event: "push",
      head_branch: "main",
      html_url: `https://x/${id}`,
      created_at: RECENT,
      updated_at: RECENT,
      ...overrides,
    };
  }

  it("paginates CI runs across pages and normalizes REST fields", async () => {
    const { exec, calls } = fakeExec((key) => {
      if (key.endsWith("page=1")) {
        return { workflow_runs: Array.from({ length: 100 }, (_, i) => restRun(i + 1)) };
      }
      if (key.endsWith("page=2")) {
        return { workflow_runs: [restRun(101, { run_attempt: 2, conclusion: "failure" })] };
      }
      return undefined;
    });
    const out = await execGitHubCiRuns({ cwd: "/x", repo: "o/r" }, signal, exec, NOW);
    assert(out.ok);
    assert.equal(out.runs.length, 101);
    assert.equal(out.runs[0]!.databaseId, 1);
    assert.equal(out.runs[100]!.attempt, 2);
    assert.equal(out.runs[100]!.conclusion, "failure");
    assert.deepEqual(calls, [
      "api repos/o/r/actions/runs?per_page=100&page=1",
      "api repos/o/r/actions/runs?per_page=100&page=2",
    ]);
  });

  it("stops paging once the page edge leaves the 7-day window", async () => {
    const old = new Date(NOW - 8 * 24 * 3600_000).toISOString();
    const { exec, calls } = fakeExec((key) => {
      if (!key.includes("page=1")) return undefined;
      return {
        workflow_runs: [
          ...Array.from({ length: 99 }, (_, i) => restRun(i + 1)),
          restRun(100, { created_at: old }),
        ],
      };
    });
    const out = await execGitHubCiRuns({ cwd: "/x", repo: "o/r" }, signal, exec, NOW);
    assert(out.ok);
    assert.equal(out.runs.length, 100);
    assert.equal(calls.length, 1); // window satisfied — no page=2 request
  });

  it("reports truncation instead of silently dropping in-window runs", async () => {
    const { exec, calls } = fakeExec((key) =>
      key.includes("actions/runs")
        ? { workflow_runs: Array.from({ length: 100 }, (_, i) => restRun(i + 1)) }
        : undefined,
    );
    const out = await execGitHubCiRuns({ cwd: "/x", repo: "o/r" }, signal, exec, NOW);
    assert(!out.ok);
    assert.match(out.error, /exceed the 1000-item bound/);
    assert.equal(calls.length, 10); // bounded — stops at the page cap
  });

  it("surfaces gh failures as honest errors", async () => {
    const exec: GhExec = async () => {
      throw new Error("gh: not logged in");
    };
    const out = await execGitHubCiRuns({ cwd: "/x", repo: "o/r" }, signal, exec, NOW);
    assert(!out.ok);
    assert.match(out.error, /not logged in/);
  });

  it("fetches PR scalars, comments, reviews and inline review comments", async () => {
    const { exec, calls } = fakeExec((key) => {
      if (key.startsWith("pr view")) {
        return { number: 42, title: "t", url: "u", state: "OPEN", mergedAt: null };
      }
      if (key.includes("issues/42/comments")) {
        return [{ id: 7, user: { login: "ada" }, body: "c", created_at: RECENT }];
      }
      if (key.includes("pulls/42/reviews")) {
        return [
          { id: 9, user: { login: "grace" }, body: "ok", state: "APPROVED", submitted_at: RECENT },
        ];
      }
      if (key.includes("pulls/42/comments")) {
        return [
          {
            id: 11,
            user: { login: "hopper" },
            body: "off-by-one",
            created_at: RECENT,
            path: "src/a.ts",
            line: 5,
            in_reply_to_id: null,
            pull_request_review_id: 9,
          },
        ];
      }
      return undefined;
    });
    const out = await execGitHubPrActivity({ cwd: "/x", repo: "o/r", pr: 42 }, signal, exec);
    assert(out.ok);
    assert.equal(out.snapshot.number, 42);
    assert.equal(out.snapshot.comments[0]!.author!.login, "ada");
    assert.equal(out.snapshot.reviews[0]!.state, "APPROVED");
    assert.equal(out.snapshot.reviewComments[0]!.id, "11");
    assert.equal(out.snapshot.reviewComments[0]!.line, 5);
    assert.equal(out.snapshot.reviewComments[0]!.path, "src/a.ts");
    assert.equal(calls.length, 4); // pr view + 3 paginated lists
  });
});

describe("global subscriptions opt-in", () => {
  it("pauses sweeps and manual execution without consuming a saved schedule", async () => {
    let enabled = false;
    const h = makeHarness({ enabled: () => enabled });
    const sub = h.engine.createSubscription({
      id: "sub_optin",
      initiativeId: "init_1",
      kind: "schedule",
      label: "One shot",
      config: { schedule: "once", runAt: T0 - 1, prompt: "Check progress" },
    });
    await h.engine.sweep();
    await h.engine.runNow(sub.id);
    assert.equal(h.sent.length, 0);
    assert.equal(h.store.get(sub.id)?.enabled, true);
    enabled = true;
    await h.engine.sweep();
    assert.equal(h.sent.length, 1);
    h.engine.dispose();
    h.db.close();
  });

  it("does not deliver a poll that finishes after opt-out", async () => {
    let enabled = true;
    const h = makeHarness({
      enabled: () => enabled,
      slackToken: SLACK_TOKEN,
      slack: () => {
        enabled = false;
        return { messages: [msg("1700000000.000001", "New event")] };
      },
    });
    const sub = h.engine.createSubscription({
      id: "sub_optin",
      initiativeId: "init_1",
      kind: "slack-channel",
      label: "Events",
      config: { channelId: "C123", catchUp: true },
    });
    await h.engine.runNow(sub.id);
    assert.equal(h.slackRequests.length, 1);
    assert.equal(h.sent.length, 0);
    assert.equal(h.store.get(sub.id)?.enabled, true);
    h.engine.dispose();
    h.db.close();
  });
});

describe("background service restarts", () => {
  it("uses a fresh engine after the service signal aborts", async () => {
    const db = makeDb();
    let startService: (signal: AbortSignal) => void | Promise<void> = () => {
      throw new Error("background service was not registered");
    };
    const disposeHooks: Array<() => void | Promise<void>> = [];
    const engine = registerInitiativeSubscriptions(
      {
        storage: { database: () => db },
        background: {
          service(_name, registration) {
            startService = (signal) => registration.start(signal);
          },
        },
        sdk: {
          threads: {
            get: async () => ({ archivedAt: null, deletedAt: null }),
            send: async () => ({}),
          },
          environments: { get: async () => ({ hostId: "host_1", path: "/repo" }) },
        },
        realtime: { publish() {} },
        log: { info() {}, warn() {}, error() {} },
        onDispose(hook) {
          disposeHooks.push(hook);
        },
      },
      {
        isEnabled: () => true,
        getCoordinatorThreadId: async () => "thr_coord",
        isInitiativeActive: () => true,
        getSlackToken: async () => undefined,
        hostCall: async () => ({ ok: false, error: "unused" }),
        sweepIntervalMs: 60_000,
      },
    );
    engine.createSubscription({
      id: "restart-once",
      initiativeId: "init_1",
      kind: "schedule",
      label: "Restart proof",
      config: { schedule: "once", runAt: T0 - 1, prompt: "resume" },
    });
    const firstSignal = new AbortController();
    const firstRun = startService(firstSignal.signal);
    firstSignal.abort();
    await firstRun;

    const secondSignal = new AbortController();
    const secondRun = startService(secondSignal.signal);
    assert.equal(await engine.runNow("restart-once"), "ran");
    secondSignal.abort();
    await secondRun;
    assert.equal(disposeHooks.length, 1);
    await disposeHooks[0]?.();
    db.close();
  });
});
