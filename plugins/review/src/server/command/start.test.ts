import { expect, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { cp, copyFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const skills = ["review-workflow", "review-quick", "review-standard", "review-deep"];
const base = "a".repeat(40),
  head = "b".repeat(40);
type ContextUsage = { usedTokens: number; modelContextWindow: number; estimated: boolean } | null;
function fixtureControls(state: {
  digest: string;
  spawnFailure: string | undefined;
  sendFailure: string | undefined;
  queuedSend: boolean;
  snapshotHead: string;
  body: string;
  contextUsage: ContextUsage;
  beforeSpawnReturn: ((id: string, runId: string) => Promise<void>) | null;
}) {
  return {
    setBeforeSpawnReturn: (value: (id: string, runId: string) => Promise<void>) => {
      state.beforeSpawnReturn = value;
    },
    setSendFailure: (value: string | undefined) => {
      state.sendFailure = value;
    },
    setUsage: (value: ContextUsage) => {
      state.contextUsage = value;
    },
    setQueuedSend: (value: boolean) => {
      state.queuedSend = value;
    },
    setDigest: (value: string) => {
      state.digest = value;
    },
    setSpawnFailure: (value: string | undefined) => {
      state.spawnFailure = value;
    },
    setHead: (value: string) => {
      state.snapshotHead = value;
    },
    setEvidence: (value: string) => {
      state.body = value;
    },
  };
}
async function load(
  providerId = "codex",
  model = "gpt-6-astra",
  originPluginId: string | null = null,
  implementation: typeof plugin = plugin,
) {
  const records = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  const logs = new Map<string, unknown[]>();
  let n = 0;
  const state = {
    digest: "a".repeat(64),
    spawnFailure: undefined as string | undefined,
    sendFailure: undefined as string | undefined,
    queuedSend: false,
    beforeSpawnReturn: null as ((id: string, runId: string) => Promise<void>) | null,
    snapshotHead: head,
    body: "Evidence from candidate bbbb",
    contextUsage: {
      usedTokens: 10000,
      modelContextWindow: 400000,
      estimated: true,
    } as ContextUsage,
  };
  const queued = new Map<
    string,
    { id: string; content: unknown[]; payload?: { kind: "retry"; retryOfTurnRequestId: string } }[]
  >();
  const authorEvents = [
    {
      seq: 1,
      type: "client/turn/requested",
      data: { requestId: "author-request", execution: { model } },
    },
    { seq: 2, type: "turn/started", scope: { kind: "turn", turnId: "author-turn" }, data: {} },
    {
      seq: 3,
      type: "turn/input/accepted",
      scope: { kind: "turn", turnId: "author-turn" },
      data: { clientRequestId: "author-request" },
    },
  ];
  function dispatch(id: string, prompt: string, execution: unknown) {
    const events = logs.get(id) ?? [];
    const seq = events.length + 1,
      requestId = `request-${seq}`,
      turnId = `turn-${seq}`;
    events.push(
      {
        seq,
        type: "client/turn/requested",
        scope: { kind: "thread" },
        data: { requestId, execution, input: [{ type: "text", text: prompt }] },
      },
      {
        seq: seq + 1,
        type: "turn/input/accepted",
        scope: { kind: "turn", turnId },
        data: { clientRequestId: requestId },
      },
    );
    logs.set(id, events);
    records.get(id)!.status = "active";
  }
  const host = createFakePluginHost({
    pluginId: "review",
    agentSkillIds: skills,
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "snapshot")
        return {
          repositoryPath: "/work/repo",
          branch: (input as { target: { branch?: string } }).target.branch ?? null,
          base,
          head: state.snapshotHead,
        };
      const offset = (input as { offset: number }).offset;
      return {
        text: "Pinned source from bbbb".slice(offset, offset + 16000),
        nextOffset: null,
        totalLength: 23,
        sha256: state.digest,
      };
    },
    sdk: {
      threads: {
        list: async () => [...records.values()],
        get: async ({ threadId }) => {
          if (threadId !== "thr_author" && !records.has(threadId))
            throw new Error("Thread not found (404)");
          return threadId === "thr_author"
            ? ({
                ...makeThreadResponse({
                  id: "thr_author",
                  projectId: "proj_1",
                  environmentId: "env_1",
                  providerId,
                  originPluginId,
                }),
                environment: {
                  id: "env_1",
                  hostId: "host_laptop",
                  path: "/work/repo",
                  status: "ready",
                },
              } as never)
            : records.get(threadId)!;
        },
        spawn: async (args) => {
          if (state.spawnFailure) throw new Error(state.spawnFailure);
          const id = `thr_reviewer_${++n}`;
          records.set(
            id,
            makeThreadResponse({
              id,
              parentThreadId: "thr_author",
              projectId: "proj_1",
              environmentId: "env_1",
              originPluginId: "review",
              providerId: args.providerId,
              status: "active",
            }),
          );
          metadata.set(id, args.pluginMetadata as Record<string, unknown>);
          dispatch(id, args.prompt!, {
            model: args.model,
            reasoningLevel: args.reasoningLevel,
            serviceTier: args.serviceTier,
          });
          await state.beforeSpawnReturn?.(
            id,
            (args.pluginMetadata as { reviewRun: { id: string } }).reviewRun.id,
          );
          return records.get(id)!;
        },
        queuedMessages: { list: async ({ threadId }) => (queued.get(threadId) ?? []) as never },
        send: async ({ threadId, input, model, reasoningLevel, serviceTier }) => {
          if (state.sendFailure) throw new Error(state.sendFailure);
          if (state.queuedSend) {
            queued.set(threadId, [{ id: "queue-1", content: input }]);
            return {
              ok: true,
              delivery: "queued",
              queuedMessage: { id: "queue-1", content: input },
              sendAt: null,
              waitingOn: { kind: "plugin", pluginId: "limiter", reason: "Quota" },
            } as const;
          }
          dispatch(threadId, input[0]!.type === "text" ? input[0]!.text : "", {
            model,
            reasoningLevel,
            serviceTier,
          });
          return { ok: true, delivery: "sent" } as const;
        },
        stop: async ({ threadId }) => {
          const record = records.get(threadId);
          if (record) record.status = "idle";
          return { ok: true } as const;
        },
        getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
        updatePluginMetadata: async ({ threadId, set }) => {
          const next = { ...metadata.get(threadId), ...set };
          metadata.set(threadId, next);
          return next;
        },
        context: async () => ({
          usage: state.contextUsage,
        }),
        wait: async () => {
          throw new Error("wait timeout");
        },
        events: {
          list: async ({ threadId, types, afterSeq, beforeSeq, order, limit }) => {
            if (Number(limit) > 100) throw new Error("Thread event limit cannot exceed 100");
            const events = (
              threadId === "thr_author" ? authorEvents : (logs.get(threadId) ?? [])
            ) as { seq: number; type: string }[];
            return events
              .filter(
                (event) =>
                  (!types || types.includes(event.type as never)) &&
                  (!afterSeq || event.seq > Number(afterSeq)) &&
                  (!beforeSeq || event.seq < Number(beforeSeq)),
              )
              .sort((a, b) => (order === "desc" ? b.seq - a.seq : a.seq - b.seq))
              .slice(0, Number(limit ?? 100)) as never;
          },
        },
        storageLocation: async () => ({ hostId: "host_laptop" }) as never,
      },
      files: { read: async () => ({ content: state.body, contentEncoding: "utf8" }) as never },
    },
  });
  await implementation(host.bb);
  const cli = (args: string[]) =>
    host.harness.behavior.runCli(args, {
      threadId: "thr_author",
      cwd: "/work/repo",
      signal: new AbortController().signal,
    });
  const start = async (input: Record<string, unknown>) => {
    const value = await host.harness.behavior.callAgentTool("review_start", input, {
      threadId: "thr_author",
    });
    if (typeof value === "string") return JSON.parse(value);
    return JSON.parse(value.content[0]!.type === "text" ? value.content[0]!.text : "null");
  };
  const tool = async (name: string, input: Record<string, unknown>, caller = "thr_author") => {
    const value = await host.harness.behavior.callAgentTool(name, input, { threadId: caller });
    if (typeof value === "string") return JSON.parse(value);
    return JSON.parse(value.content[0]!.type === "text" ? value.content[0]!.text : "null");
  };
  function finish(id: string, runId: string, status = "complete", contamination = false) {
    const events = logs.get(id)! as {
      seq: number;
      type: string;
      scope?: { kind: string; turnId?: string };
      data: Record<string, unknown>;
    }[];
    const turnId = events.at(-1)!.scope!.turnId!;
    let seq = events.length + 1;
    if (contamination)
      events.push({
        seq: seq++,
        type: "turn/input/accepted",
        scope: { kind: "turn", turnId },
        data: { clientRequestId: "other-steering" },
      });
    events.push(
      {
        seq: seq++,
        type: "item/completed",
        scope: { kind: "turn", turnId },
        data: {
          item: {
            type: "agentMessage",
            text: JSON.stringify({
              runId,
              status,
              findings: [],
              coverage: "Checked the complete fixed candidate",
              limitations: [],
            }),
          },
        },
      },
      {
        seq,
        type: "turn/completed",
        scope: { kind: "turn", turnId },
        data: { status: "completed" },
      },
    );
    records.get(id)!.status = "idle";
  }
  return {
    host,
    cli,
    start,
    tool,
    finish,
    records,
    logs,
    metadata,
    queued,
    ...fixtureControls(state),
  };
}

type Fixture = Awaited<ReturnType<typeof load>>;
type Run = { runId: string; threadIds: string[] };
function finishAll(f: Fixture, run: Run, status = "complete") {
  for (const id of run.threadIds) f.finish(id, run.runId, status);
}
async function readDiff(f: Fixture, run: Run, offset = 0) {
  for (const id of run.threadIds)
    await f.tool("review_context", { runId: run.runId, section: "diff", offset }, id);
}

for (const [mode, effort, title, panel] of [
  ["quick", "medium", "Quick", [["claude-code", "claude-opus-5-5[1m]", "Claude"]]],
  [
    "standard",
    "high",
    "Standard",
    [
      ["claude-code", "claude-opus-5-5[1m]", "Claude"],
      ["codex", "gpt-6-astra", "Codex"],
    ],
  ],
  [
    "deep",
    "max",
    "Deep",
    [
      ["claude-code", "claude-opus-5-5[1m]", "Claude"],
      ["codex", "gpt-6-astra", "Codex"],
    ],
  ],
] as const) {
  test(`${mode} dispatches ${panel.length} reviewer(s) at ${effort} effort`, async () => {
    const f = await load();
    const r = await f.start({
      mode,
      summary: "Check the camera",
      target: { branch: "scott/camera" },
    });
    expect(r).toMatchObject({
      kind: "implementation",
      mode,
      status: "running",
      target: { branch: "scott/camera", base, head },
      threadIds: panel.map((_, index) => `thr_reviewer_${index + 1}`),
      reviewers: panel.map(([providerId, model]) => ({ providerId, model })),
    });
    const spawns = f.host.harness.inspection.sdk
      .callsTo("threads.spawn")
      .map(([args]) => args as Record<string, unknown>);
    expect(
      spawns.map(({ providerId, model, reasoningLevel, serviceTier, visibility, title }) => ({
        providerId,
        model,
        reasoningLevel,
        serviceTier,
        visibility,
        title,
      })),
    ).toEqual(
      panel.map(([providerId, model, family]) => ({
        providerId,
        model,
        reasoningLevel: effort,
        serviceTier: "fast",
        visibility: "hidden",
        title: `${title} implementation review (${family})`,
      })),
    );
    expect(new Set(spawns.map((spawn) => spawn.prompt)).size).toBe(1);
    expect(String(spawns[0]!.prompt)).toContain(`Review run ${r.runId}: implementation, ${mode}`);
    expect(spawns.map((spawn) => spawn.pluginMetadata)).toMatchObject(
      panel.map(([providerId, model], seat) => ({
        reviewRun: { id: r.runId, seat, reviewer: { providerId, model } },
      })),
    );
    await f.host.harness.lifecycle.dispose();
  });
}

test("a Claude author's panel puts Codex first and Claude second", async () => {
  const f = await load("claude-code", "claude-opus-5-5[1m]");
  const r = await f.start({ kind: "design", mode: "deep", summary: "Plan" });
  expect(r.reviewers).toEqual([
    { providerId: "codex", model: "gpt-6-astra" },
    { providerId: "claude-code", model: "claude-opus-5-5[1m]" },
  ]);
  const quick = await load("claude-code", "claude-opus-5-5[1m]");
  expect((await quick.start({ kind: "design", mode: "quick", summary: "Plan" })).reviewers).toEqual(
    [{ providerId: "codex", model: "gpt-6-astra" }],
  );
});

test("result stays running until every reviewer finishes, then returns one report per model", async () => {
  const f = await load();
  const r = await f.start({ kind: "design", summary: "Plan" });
  const [claude, codex] = r.threadIds;
  f.finish(claude, r.runId);
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "running",
    reviews: [
      { reviewer: { providerId: "claude-code" }, threadId: claude, status: "finished" },
      { reviewer: { providerId: "codex" }, threadId: codex, status: "running" },
    ],
  });
  expect(await f.start({ kind: "design", summary: "Next", reuse: "new" })).toMatchObject({
    runId: r.runId,
    busy: true,
  });
  f.finish(codex, r.runId);
  const done = await f.tool("review_result", { runId: r.runId });
  expect(done).toMatchObject({
    status: "complete",
    current: true,
    deepImplementationCovered: false,
    error: null,
    reviews: [
      {
        reviewer: { providerId: "claude-code", model: "claude-opus-5-5[1m]" },
        threadId: claude,
        status: "complete",
        report: { runId: r.runId, status: "complete" },
        error: null,
      },
      {
        reviewer: { providerId: "codex", model: "gpt-6-astra" },
        threadId: codex,
        status: "complete",
        report: { runId: r.runId, status: "complete" },
        error: null,
      },
    ],
  });
  expect(done).not.toHaveProperty("report");
  const stored = await f.tool("review_context", { runId: r.runId, section: "report" });
  expect(
    JSON.parse(stored.text).map((entry: { reviewer: { providerId: string } }) => entry.reviewer),
  ).toEqual([
    { providerId: "claude-code", model: "claude-opus-5-5[1m]" },
    { providerId: "codex", model: "gpt-6-astra" },
  ]);
});

for (const seat of [0, 1])
  test(`a P1 from reviewer ${seat + 1} blocks Deep publication`, async () => {
    const f = await load();
    const r = await f.start({
      mode: "deep",
      scope: "publication",
      summary: "Publish",
      target: { branch: "scott/camera" },
    });
    await readDiff(f, r);
    finishAll(f, r);
    const message = f.logs
      .get(r.threadIds[seat])!
      .find((event) => (event as { type: string }).type === "item/completed") as {
      data: { item: { text: string } };
    };
    const report = JSON.parse(message.data.item.text);
    report.findings = [{ priority: 1, title: "Broken publish", body: "Evidence", location: "x:1" }];
    message.data.item.text = JSON.stringify(report);
    const result = await f.tool("review_result", { runId: r.runId });
    expect(result).toMatchObject({ status: "complete", deepImplementationCovered: false });
    expect(
      result.reviews.map(
        (review: { report: { findings: unknown[] } }) => review.report.findings.length,
      ),
    ).toEqual(seat ? [0, 1] : [1, 0]);
  });

test("Deep publication clears only when every reviewer reads every diff page", async () => {
  const f = await load();
  const r = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Publish",
    target: { branch: "scott/camera" },
  });
  await f.tool("review_context", { runId: r.runId, section: "diff" }, r.threadIds[0]);
  finishAll(f, r);
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "incomplete",
    deepImplementationCovered: false,
    error: "1 of 2 reviewers did not complete; see reviews[].error",
    reviews: [
      { status: "complete", diffCoverage: { complete: true }, error: null },
      {
        status: "incomplete",
        diffCoverage: { complete: false },
        error: "Deep assessment is incomplete: the reviewer did not read every pinned diff page",
      },
    ],
  });
  const both = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Publish again",
    target: { branch: "scott/camera" },
    reuse: "new",
  });
  await readDiff(f, both);
  finishAll(f, both);
  expect(await f.tool("review_result", { runId: both.runId })).toMatchObject({
    status: "complete",
    deepImplementationCovered: true,
    reviews: [{ status: "complete" }, { status: "complete" }],
  });
});

test("a run stored by contract 3 stays busy and readable after upgrade", async () => {
  const f = await load();
  const r = await f.start({ kind: "design", mode: "quick", summary: "Plan", workstream: "plan" });
  const db = f.host.bb.storage.database();
  const row = db
    .prepare<[string], { payload: string }>("SELECT payload FROM review_runs WHERE id=?")
    .get(r.runId)!;
  const { seats, ...rest } = JSON.parse(row.payload);
  const legacy = {
    ...rest,
    contractVersion: 3,
    reviewer: seats[0].reviewer,
    reviewerThreadId: seats[0].threadId,
    afterSeq: seats[0].afterSeq,
  };
  db.prepare("UPDATE review_runs SET payload=? WHERE id=?").run(JSON.stringify(legacy), r.runId);
  expect(await f.start({ kind: "design", summary: "Next", reuse: "new" })).toMatchObject({
    runId: r.runId,
    threadIds: ["thr_reviewer_1"],
    reviewers: [{ providerId: "claude-code", model: "claude-opus-5-5[1m]" }],
    busy: true,
  });
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({ status: "running" });
  f.finish("thr_reviewer_1", r.runId);
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "complete",
    reviews: [{ threadId: "thr_reviewer_1", status: "complete", report: { runId: r.runId } }],
  });
  // A contract-3 reviewer is never auto-reused by a contract-4 run.
  const next = await f.start({
    kind: "design",
    mode: "quick",
    summary: "Plan v2",
    workstream: "plan",
  });
  expect(next).toMatchObject({ threadIds: ["thr_reviewer_2"], reused: false });
});

test("a contract-3 Deep publication run keeps its diff coverage recorded under bare turn ids", async () => {
  const f = await load();
  const r = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Publish",
    target: { branch: "scott/camera" },
  });
  const [reviewer] = r.threadIds as [string];
  await f.tool("review_context", { runId: r.runId, section: "diff" }, reviewer);
  const db = f.host.bb.storage.database();
  db.prepare("UPDATE review_turn_reads SET turn_id=replace(turn_id, ?, '') WHERE run_id=?").run(
    `${reviewer}:`,
    r.runId,
  );
  const row = db
    .prepare<[string], { payload: string }>("SELECT payload FROM review_runs WHERE id=?")
    .get(r.runId)!;
  const { seats, ...rest } = JSON.parse(row.payload);
  const legacy = {
    ...rest,
    contractVersion: 3,
    reviewer: seats[0].reviewer,
    reviewerThreadId: seats[0].threadId,
    afterSeq: seats[0].afterSeq,
  };
  db.prepare("UPDATE review_runs SET payload=? WHERE id=?").run(JSON.stringify(legacy), r.runId);
  f.finish(reviewer, r.runId);
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "complete",
    current: true,
    deepImplementationCovered: true,
    reviews: [{ threadId: reviewer, status: "complete", diffCoverage: { complete: true } }],
  });
});

test("an interrupted panel dispatch adopts nothing twice and expires as before", async () => {
  const f = await load();
  f.setBeforeSpawnReturn(async () => f.setSpawnFailure("Gateway timeout"));
  await expect(f.start({ kind: "design", summary: "Plan" })).rejects.toThrow("Gateway timeout");
  f.setSpawnFailure(undefined);
  f.setBeforeSpawnReturn(async () => {});
  expect(await f.start({ kind: "design", summary: "Retry" })).toMatchObject({
    status: "starting",
    threadIds: ["thr_reviewer_1", null],
    busy: true,
  });
  expect(f.host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  const db = f.host.bb.storage.database();
  const row = db
    .prepare<[], { id: string; payload: string }>("SELECT id,payload FROM review_runs")
    .get()!;
  const run = JSON.parse(row.payload);
  run.startedAt = Date.now() - 121000;
  db.prepare("UPDATE review_runs SET payload=? WHERE id=?").run(JSON.stringify(run), row.id);
  const next = await f.start({ kind: "design", summary: "After expiry" });
  expect(next).toMatchObject({
    status: "running",
    threadIds: ["thr_reviewer_2", "thr_reviewer_3"],
  });
  expect(f.host.harness.inspection.sdk.callsTo("threads.stop").map(([args]) => args)).toEqual([
    { threadId: "thr_reviewer_1" },
  ]);
  expect(await f.tool("review_result", { runId: row.id })).toMatchObject({
    status: "failed",
    error: "Dispatch expired without a child for every reviewer",
  });
});

test("design starts from a concise immutable proposal without requiring a code diff", async () => {
  const f = await load("claude-code", "claude-opus-5-5[1m]");
  const r = await f.start({ kind: "design", summary: "Choose a queue boundary" });
  expect(r).toMatchObject({ kind: "design", mode: "standard", target: null });
  expect(f.host.harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
    providerId: "codex",
    reasoningLevel: "high",
  });
  expect(
    await f.tool("review_context", { runId: r.runId, section: "brief" }, r.threadIds[0]),
  ).toEqual({
    text: "Choose a queue boundary",
    nextOffset: null,
  });
});

test("missing implementation target and moving workspace selectors do not launch reviews", async () => {
  const f = await load();
  await expect(f.start({ summary: "Review everything" })).rejects.toThrow(
    "needs a GitButler branch checkpoint",
  );
  await expect(
    f.start({ summary: "Review everything", target: { branch: "gitbutler/workspace" } }),
  ).rejects.toThrow();
  await expect(
    f.start({ summary: "Review everything", target: { base: "main", head: "HEAD" } }),
  ).rejects.toThrow();
  const valid = await f.start({
    summary: "Review intended work",
    target: { branch: "scott/camera" },
  });
  expect(valid.target.head).toBe(head);
});

test("concurrent starts preserve the active candidate and return the same run", async () => {
  const f = await load();
  const [a, b] = await Promise.all([
    f.start({ summary: "First", target: { branch: "scott/camera" } }),
    f.start({ summary: "Second", target: { branch: "scott/camera" } }),
  ]);
  expect(a.runId).toBe(b.runId);
  expect(b.busy).toBe(true);
  expect(await f.tool("review_context", { runId: a.runId, section: "brief" })).toEqual({
    text: "First",
    nextOffset: null,
  });
});

test("idle reviewer is reused with a fresh run and per-turn effort; old output never clears it", async () => {
  const f = await load();
  const first = await f.start({
    mode: "standard",
    summary: "Initial",
    target: { branch: "scott/camera" },
  });
  finishAll(f, first);
  const second = await f.start({
    mode: "quick",
    summary: "Final candidate",
    target: { branch: "scott/camera" },
  });
  expect(second.threadIds).toEqual([first.threadIds[0]]);
  expect(second.runId).not.toBe(first.runId);
  expect(second.reused).toBe(true);
  expect(f.host.harness.inspection.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({
    reasoningLevel: "medium",
    mode: "start",
  });
  const pending = await f.tool("review_result", { runId: second.runId });
  expect(pending.status).toBe("running");
  finishAll(f, second);
  const done = await f.tool("review_result", { runId: second.runId });
  expect(done).toMatchObject({
    status: "complete",
    current: true,
    deepImplementationCovered: false,
    reviews: [{ report: { runId: second.runId } }],
  });
  const old = await f.tool("review_result", { runId: first.runId });
  expect(old.reviews.map((review: { report: { runId: string } }) => review.report.runId)).toEqual([
    first.runId,
    first.runId,
  ]);
  expect(old.deepImplementationCovered).toBe(false);
});

test("changed target makes Deep results stale, while unrelated workspace changes leave coverage valid", async () => {
  const f = await load();
  const r = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Final",
    target: { branch: "scott/camera" },
  });
  await readDiff(f, r);
  finishAll(f, r);
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "complete",
    current: true,
    deepImplementationCovered: true,
  });
  f.setHead("c".repeat(40));
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "complete",
    current: false,
    deepImplementationCovered: false,
  });
});

test("incomplete and steered reviews never satisfy Deep coverage", async () => {
  const f = await load();
  const r = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Final",
    target: { branch: "scott/camera" },
  });
  finishAll(f, r, "incomplete");
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "incomplete",
    deepImplementationCovered: false,
  });
  const s = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "New check",
    target: { branch: "scott/camera" },
    reuse: "new",
  });
  await readDiff(f, s);
  f.finish(s.threadIds[0], s.runId, "complete", true);
  f.finish(s.threadIds[1], s.runId);
  expect(await f.tool("review_result", { runId: s.runId })).toMatchObject({
    status: "incomplete",
    deepImplementationCovered: false,
  });
});

test("context is captured on the invoking host and cannot be read by another thread", async () => {
  const f = await load();
  const r = await f.start({
    kind: "design",
    summary: "Plan",
    evidence: [{ label: "Checks", path: "/work/result.txt" }],
  });
  f.setEvidence("changed later");
  const evidence = await f.tool("review_context", { runId: r.runId, section: "evidence" });
  expect(JSON.parse(evidence.text)[0]).toMatchObject({
    label: "Checks",
    text: "Evidence from candidate bbbb",
  });
  expect(f.host.harness.inspection.sdk.callsTo("files.read")[0]?.[0]).toMatchObject({
    hostId: "host_laptop",
    path: "/work/result.txt",
  });
  await expect(
    f.tool("review_context", { runId: r.runId, section: "brief" }, "thr_other"),
  ).rejects.toThrow("not available");
});

test("CLI preserves --file on the calling host and emits a run receipt", async () => {
  const f = await load();
  const result = await f.cli([
    "start",
    "--kind",
    "design",
    "--file",
    "brief.md",
    "--mode",
    "quick",
    "--json",
  ]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout!)).toMatchObject({ kind: "design", mode: "quick", target: null });
  expect(f.host.harness.inspection.sdk.callsTo("files.read")[0]?.[0]).toMatchObject({
    hostId: "host_laptop",
    path: "/work/repo/brief.md",
  });
});

test("reviewers cannot recurse even through CLI", async () => {
  const f = await load("codex", "gpt-6-astra", "review");
  const result = await f.cli(["start", "--kind", "design", "--prompt", "Recurse"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("cannot start another review");
});

test("mixed-family author selection uses accepted turn rather than later preferences", async () => {
  const f = await load("agent-proxy", "openai/gpt-5.4");
  const r = await f.start({ kind: "design", summary: "Plan" });
  expect(r.status).toBe("running");
  expect(f.host.harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
    providerId: "claude-code",
  });
});

test("reuse:new starts fresh and partial diff reads never clear the publication candidate", async () => {
  const f = await load();
  const first = await f.start({ summary: "Earlier", target: { branch: "scott/camera" } });
  finishAll(f, first);
  const run = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Publish",
    target: { branch: "scott/camera" },
    reuse: "new",
  });
  expect(run.threadIds).not.toContain(first.threadIds[0]);
  expect(run.threadIds).not.toContain(first.threadIds[1]);
  await f.tool("review_context", { runId: run.runId, section: "diff" }); // Author preview is not reviewer coverage.
  await readDiff(f, run, 10);
  finishAll(f, run);
  expect(await f.tool("review_result", { runId: run.runId })).toMatchObject({
    deepImplementationCovered: false,
    reviews: [{ diffCoverage: { complete: false } }, { diffCoverage: { complete: false } }],
  });
});

test("execution downgrade, model fallback, and unresolved blockers prevent Deep clearance", async () => {
  for (const reason of ["effort", "fallback", "finding"]) {
    const f = await load();
    const r = await f.start({
      mode: "deep",
      scope: "publication",
      summary: "Publish",
      target: { branch: "scott/camera" },
    });
    await readDiff(f, r);
    if (reason === "effort")
      (
        f.logs.get(r.threadIds[0])![0] as { data: { execution: { reasoningLevel: string } } }
      ).data.execution.reasoningLevel = "high";
    finishAll(f, r);
    const log = f.logs.get(r.threadIds[0])!;
    if (reason === "fallback")
      log.push({
        seq: 99,
        type: "provider/modelFallback",
        scope: { kind: "turn", turnId: "turn-1" },
        data: {},
      });
    if (reason === "finding") {
      const message = log.find(
        (event) => (event as { type: string }).type === "item/completed",
      ) as { data: { item: { text: string } } };
      const report = JSON.parse(message.data.item.text);
      report.findings = [
        { priority: 1, title: "Broken publish", body: "Evidence", location: "x:1" },
      ];
      message.data.item.text = JSON.stringify(report);
    }
    expect((await f.tool("review_result", { runId: r.runId })).deepImplementationCovered).toBe(
      false,
    );
  }
});

test("persistent reservations prevent a second service instance from spawning over an active run", async () => {
  const f = await load();
  const r = await f.start({ summary: "First", target: { branch: "scott/camera" } });
  const { ReviewService } = await import("../lib/service.ts");
  const { requestSchema } = await import("../../shared/schema.ts");
  const afterReload = new ReviewService(f.host.bb, async () => ({
    claudeModel: "claude-opus-5-5[1m]",
    codexModel: "gpt-6-astra",
  }));
  const next = await afterReload.start(
    "thr_author",
    requestSchema.parse({ summary: "Retry", target: { branch: "scott/camera" } }),
    new AbortController().signal,
  );
  expect(next.runId).toBe(r.runId);
  expect(f.host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
});

test("a definite dispatch rejection releases the reservation for a corrected retry", async () => {
  const f = await load();
  f.setSpawnFailure("Unknown reviewer model");
  await expect(f.start({ kind: "design", summary: "Plan" })).rejects.toThrow(
    "Unknown reviewer model",
  );
  f.setSpawnFailure(undefined);
  expect(await f.start({ kind: "design", summary: "Plan" })).toMatchObject({
    status: "running",
    threadIds: ["thr_reviewer_1", "thr_reviewer_2"],
  });
});

test("a definite rejection of the second reviewer stops the first and releases the reservation", async () => {
  const f = await load();
  f.setBeforeSpawnReturn(async () => f.setSpawnFailure("Unknown reviewer model"));
  await expect(f.start({ kind: "design", summary: "Plan" })).rejects.toThrow(
    "Unknown reviewer model",
  );
  expect(f.host.harness.inspection.sdk.callsTo("threads.stop").map(([args]) => args)).toEqual([
    { threadId: "thr_reviewer_1" },
  ]);
  expect(f.metadata.get("thr_reviewer_1")).toMatchObject({
    reviewRun: { seat: 0, status: "failed" },
  });
  f.setSpawnFailure(undefined);
  f.setBeforeSpawnReturn(async () => {});
  expect(await f.start({ kind: "design", summary: "Plan", reuse: "new" })).toMatchObject({
    status: "running",
    threadIds: ["thr_reviewer_2", "thr_reviewer_3"],
  });
});

test("an ambiguous dispatch timeout retains a reservation across service reload", async () => {
  const f = await load();
  f.setSpawnFailure("Gateway timeout");
  await expect(f.start({ kind: "design", summary: "Plan" })).rejects.toThrow("Gateway timeout");
  f.setSpawnFailure(undefined);
  const { ReviewService } = await import("../lib/service.ts");
  const { requestSchema } = await import("../../shared/schema.ts");
  const afterReload = new ReviewService(f.host.bb, async () => ({
    claudeModel: "claude-opus-5-5[1m]",
    codexModel: "gpt-6-astra",
  }));
  const next = await afterReload.start(
    "thr_author",
    requestSchema.parse({ kind: "design", summary: "Retry" }),
    new AbortController().signal,
  );
  expect(next).toMatchObject({ status: "starting", busy: true });
  expect(f.host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

test("reads from a later unrelated reviewer turn cannot clear an earlier partial Deep assessment", async () => {
  const f = await load();
  const r = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Publish",
    target: { branch: "scott/camera" },
  });
  finishAll(f, r);
  for (const id of r.threadIds)
    f.logs.get(id)!.push({
      seq: 100,
      type: "turn/input/accepted",
      scope: { kind: "turn", turnId: "later-turn" },
      data: { clientRequestId: "unrelated-request" },
    });
  await readDiff(f, r);
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "incomplete",
    deepImplementationCovered: false,
    reviews: [{ diffCoverage: { complete: false } }, { diffCoverage: { complete: false } }],
  });
});

test("mixed diff representations never establish complete Deep coverage", async () => {
  const f = await load();
  const r = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Publish",
    target: { branch: "scott/camera" },
  });
  await readDiff(f, r);
  f.setDigest("b".repeat(64));
  await f.tool("review_context", { runId: r.runId, section: "diff", offset: 10 }, r.threadIds[0]);
  finishAll(f, r);
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "incomplete",
    deepImplementationCovered: false,
    reviews: [
      { status: "incomplete", diffCoverage: { consistent: false } },
      { status: "complete", diffCoverage: { consistent: true } },
    ],
  });
});

test("deleted reviewers do not block results or replacement reviews", async () => {
  const f = await load();
  const r = await f.start({ kind: "design", summary: "Plan" });
  f.records.delete(r.threadIds[0]);
  f.finish(r.threadIds[1], r.runId);
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "incomplete",
    deepImplementationCovered: false,
    reviews: [
      {
        status: "failed",
        report: null,
        error: "Reviewer thread was deleted; start a new assessment",
      },
      { status: "complete", report: { runId: r.runId } },
    ],
  });
  const next = await f.start({ kind: "design", summary: "Replacement" });
  expect(next.threadIds).not.toContain(r.threadIds[0]);
  for (const id of next.threadIds) f.records.delete(id);
  expect(
    await f.start({ kind: "design", summary: "New after deletion", reuse: "new" }),
  ).toMatchObject({ status: "running" });
});

test("expired orphan dispatch releases its reservation", async () => {
  const f = await load();
  f.setSpawnFailure("Gateway timeout");
  await expect(f.start({ kind: "design", summary: "Plan" })).rejects.toThrow();
  const db = f.host.bb.storage.database();
  const row = db
    .prepare<[], { id: string; payload: string }>("SELECT id,payload FROM review_runs")
    .get()!;
  const run = JSON.parse(row.payload);
  run.startedAt = Date.now() - 121000;
  db.prepare("UPDATE review_runs SET payload=? WHERE id=?").run(JSON.stringify(run), row.id);
  f.setSpawnFailure(undefined);
  expect(await f.start({ kind: "design", summary: "Retry" })).toMatchObject({ status: "running" });
});

test("BB fast-tier demotion does not invalidate a complete Deep assessment", async () => {
  const f = await load();
  const r = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Publish",
    target: { branch: "scott/camera" },
  });
  for (const id of r.threadIds)
    (
      f.logs.get(id)![0] as { data: { execution: { serviceTier: string } } }
    ).data.execution.serviceTier = "default";
  await readDiff(f, r);
  finishAll(f, r);
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "complete",
    deepImplementationCovered: true,
  });
});

test("a failed reviewer returns an incomplete result without waiting for unreachable idle", async () => {
  const f = await load();
  const r = await f.start({ kind: "design", summary: "Plan" });
  for (const id of r.threadIds) f.records.get(id)!.status = "error";
  expect(await f.tool("review_result", { runId: r.runId, waitSeconds: 1 })).toMatchObject({
    status: "incomplete",
    deepImplementationCovered: false,
  });
  expect(f.host.harness.inspection.sdk.callsTo("threads.wait")).toHaveLength(0);
});

for (const retryOfFailed of [true, false])
  test(`retry chain with earlier ${retryOfFailed ? "failed" : "completed"} attempt`, async () => {
    const f = await load();
    const r = await f.start({
      mode: "deep",
      scope: "publication",
      summary: "Publish",
      target: { branch: "scott/camera" },
    });
    const log = f.logs.get(r.threadIds[0])! as {
      seq: number;
      type: string;
      scope: { kind: string; turnId?: string };
      data: Record<string, unknown>;
    }[];
    const original = log[0]!;
    log.push({
      seq: 3,
      type: "turn/completed",
      scope: { kind: "turn", turnId: "turn-1" },
      data: { status: retryOfFailed ? "failed" : "completed" },
    });
    log.push(
      {
        seq: 4,
        type: "client/turn/requested",
        scope: { kind: "thread" },
        data: { ...original.data, requestId: "retry-1", retryOfRequestId: original.data.requestId },
      },
      {
        seq: 5,
        type: "turn/input/accepted",
        scope: { kind: "turn", turnId: "retry-turn" },
        data: { clientRequestId: "retry-1" },
      },
    );
    await readDiff(f, r);
    finishAll(f, r);
    expect((await f.tool("review_result", { runId: r.runId })).deepImplementationCovered).toBe(
      retryOfFailed,
    );
  });

test("only the successful retry's own diff reads establish coverage", async () => {
  const f = await load();
  const r = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Publish",
    target: { branch: "scott/camera" },
  });
  await readDiff(f, r);
  const log = f.logs.get(r.threadIds[0])! as {
    seq: number;
    type: string;
    scope: { kind: string; turnId?: string };
    data: Record<string, unknown>;
  }[];
  const original = log[0]!;
  log.push(
    {
      seq: 3,
      type: "turn/completed",
      scope: { kind: "turn", turnId: "turn-1" },
      data: { status: "failed" },
    },
    {
      seq: 4,
      type: "client/turn/requested",
      scope: { kind: "thread" },
      data: { ...original.data, requestId: "retry-1", retryOfRequestId: original.data.requestId },
    },
    {
      seq: 5,
      type: "turn/input/accepted",
      scope: { kind: "turn", turnId: "retry-turn" },
      data: { clientRequestId: "retry-1" },
    },
  );
  finishAll(f, r);
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "incomplete",
    deepImplementationCovered: false,
    reviews: [{ status: "incomplete" }, { status: "complete" }],
  });
});

test("queued reuse reserves the author until dispatch or cancellation", async () => {
  const f = await load();
  const first = await f.start({ kind: "design", summary: "Initial", workstream: "plan" });
  finishAll(f, first);
  f.setQueuedSend(true);
  const queued = await f.start({ kind: "design", summary: "Next", workstream: "plan" });
  expect(queued.reused).toBe(true);
  expect(await f.tool("review_result", { runId: queued.runId })).toMatchObject({
    status: "queued",
    deepImplementationCovered: false,
  });
  expect(
    await f.start({ kind: "design", summary: "Another", workstream: "plan", reuse: "new" }),
  ).toMatchObject({ runId: queued.runId, busy: true });
  f.queued.clear();
  expect(await f.tool("review_result", { runId: queued.runId })).toMatchObject({
    status: "incomplete",
    deepImplementationCovered: false,
  });
  f.setQueuedSend(false);
  expect(
    await f.start({ kind: "design", summary: "After cancel", workstream: "plan" }),
  ).toMatchObject({ status: "running" });
});

test("large result preserves its clearance flag and paged-report pointer", async () => {
  const f = await load();
  const r = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Publish",
    target: { branch: "scott/camera" },
  });
  await readDiff(f, r);
  finishAll(f, r);
  const message = f.logs
    .get(r.threadIds[0])!
    .find((event) => (event as { type: string }).type === "item/completed") as {
    data: { item: { text: string } };
  };
  const report = JSON.parse(message.data.item.text);
  report.findings = Array.from({ length: 9 }, () => ({
    priority: 3,
    title: "Minor",
    body: "x".repeat(7900),
    location: "a.ts:1",
  }));
  message.data.item.text = JSON.stringify(report);
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "complete",
    deepImplementationCovered: true,
    reviews: [
      {
        status: "complete",
        findings: 9,
        blocking: 0,
        diffCoverage: { complete: true, unreadCount: 0 },
      },
      {
        status: "complete",
        findings: 0,
        blocking: 0,
        diffCoverage: { complete: true, unreadCount: 0 },
      },
    ],
    nextOffset: 0,
  });
});

test("result pagination finds assessment output beyond the first SDK event page", async () => {
  const f = await load();
  const r = await f.start({ kind: "design", summary: "Plan" });
  const log = f.logs.get(r.threadIds[0])!;
  for (let i = 0; i < 103; i++)
    log.push({
      seq: 3 + i,
      type: "item/completed",
      scope: { kind: "turn", turnId: "turn-1" },
      data: { item: { type: "agentMessage", text: "intermediate" } },
    });
  // finish uses the last event's turn; only the final structured message clears.
  finishAll(f, r);
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "complete",
    reviews: [{ report: { runId: r.runId } }, { report: { runId: r.runId } }],
  });
});

test("multiple BB continuation retries bind to their original request and latest attempt", async () => {
  const f = await load();
  const r = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Publish",
    target: { branch: "scott/camera" },
  });
  const log = f.logs.get(r.threadIds[0])! as {
    seq: number;
    type: string;
    scope: { kind: string; turnId?: string };
    data: Record<string, unknown>;
  }[];
  const root = log[0]!;
  for (let attempt = 2; attempt <= 3; attempt++) {
    const previousTurn = attempt === 2 ? "turn-1" : "retry-2";
    log.push({
      seq: log.length + 1,
      type: "turn/completed",
      scope: { kind: "turn", turnId: previousTurn },
      data: { status: "failed" },
    });
    log.push({
      seq: log.length + 1,
      type: "client/turn/requested",
      scope: { kind: "thread" },
      data: {
        ...root.data,
        requestId: `request-retry-${attempt}`,
        retryOfRequestId: root.data.requestId,
        retryAttempt: attempt,
        input: [{ type: "text", text: "Please continue.", mentions: [], visibility: "agent-only" }],
      },
    });
    log.push({
      seq: log.length + 1,
      type: "turn/input/accepted",
      scope: { kind: "turn", turnId: `retry-${attempt}` },
      data: { clientRequestId: `request-retry-${attempt}` },
    });
  }
  await readDiff(f, r);
  finishAll(f, r);
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "complete",
    deepImplementationCovered: true,
  });
});

test("a provider door rejection can be retried without an accepted turn", async () => {
  const f = await load();
  const r = await f.start({ kind: "design", summary: "Plan" });
  const log = f.logs.get(r.threadIds[0])! as {
    seq: number;
    type: string;
    scope: { kind: string; turnId?: string };
    data: Record<string, unknown>;
  }[];
  const root = log[0]!;
  log.splice(1);
  log.push({
    seq: 2,
    type: "client/turn/rejected",
    scope: { kind: "thread" },
    data: { requestId: root.data.requestId, reason: "rate_limited" },
  });
  log.push(
    {
      seq: 3,
      type: "client/turn/requested",
      scope: { kind: "thread" },
      data: {
        ...root.data,
        requestId: "door-retry",
        retryOfRequestId: root.data.requestId,
        input: (root.data.input as Record<string, unknown>[]).map((item) =>
          Object.assign({}, item, { visibility: "agent-only" }),
        ),
      },
    },
    {
      seq: 4,
      type: "turn/input/accepted",
      scope: { kind: "turn", turnId: "door-retry-turn" },
      data: { clientRequestId: "door-retry" },
    },
  );
  finishAll(f, r);
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "complete",
    reviews: [{ report: { runId: r.runId } }, { report: { runId: r.runId } }],
  });
});

test("a retry cannot clear a review whose earlier attempt was steered", async () => {
  const f = await load();
  const r = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Publish",
    target: { branch: "scott/camera" },
  });
  const log = f.logs.get(r.threadIds[0])! as {
    seq: number;
    type: string;
    scope: { kind: string; turnId?: string };
    data: Record<string, unknown>;
  }[];
  const root = log[0]!;
  log.push(
    {
      seq: 3,
      type: "turn/input/accepted",
      scope: { kind: "turn", turnId: "turn-1" },
      data: { clientRequestId: "foreign-steering" },
    },
    {
      seq: 4,
      type: "turn/completed",
      scope: { kind: "turn", turnId: "turn-1" },
      data: { status: "failed" },
    },
    {
      seq: 5,
      type: "client/turn/requested",
      scope: { kind: "thread" },
      data: {
        ...root.data,
        requestId: "retry",
        retryOfRequestId: root.data.requestId,
        input: [{ type: "text", text: "Please continue.", visibility: "agent-only" }],
      },
    },
    {
      seq: 6,
      type: "turn/input/accepted",
      scope: { kind: "turn", turnId: "retry-turn" },
      data: { clientRequestId: "retry" },
    },
  );
  await readDiff(f, r);
  finishAll(f, r);
  expect((await f.tool("review_result", { runId: r.runId })).deepImplementationCovered).toBe(false);
});

test("queued continuation retry remains pending instead of releasing the author reservation", async () => {
  const f = await load();
  const r = await f.start({ kind: "design", summary: "Plan" });
  f.records.get(r.threadIds[0])!.status = "error";
  f.queued.set(r.threadIds[0], [
    {
      id: "retry-queue",
      content: [{ type: "text", text: "Please continue.", visibility: "agent-only" }],
      payload: { kind: "retry", retryOfTurnRequestId: "request-1" },
    },
  ]);
  expect(await f.tool("review_result", { runId: r.runId })).toMatchObject({
    status: "queued",
    deepImplementationCovered: false,
  });
  expect(await f.start({ kind: "design", summary: "Next", reuse: "new" })).toMatchObject({
    runId: r.runId,
    busy: true,
  });
});

test("Deep fix verification reuses an eligible reviewer with a new maximum-effort turn", async () => {
  const f = await load();
  const first = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Initial",
    target: { branch: "scott/camera" },
  });
  await readDiff(f, first);
  finishAll(f, first);
  f.setHead("c".repeat(40));
  const next = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Verify fixes",
    target: { branch: "scott/camera" },
    reuse: { threadId: first.threadIds[0] },
  });
  expect(next).toMatchObject({
    threadIds: [first.threadIds[0], "thr_reviewer_3"],
    reused: true,
    status: "running",
  });
  expect(next.runId).not.toBe(first.runId);
  expect(f.host.harness.inspection.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({
    reasoningLevel: "max",
  });
  finishAll(f, next);
  expect((await f.tool("review_result", { runId: next.runId })).deepImplementationCovered).toBe(
    false,
  );
  // Older full coverage cannot replace this new candidate's reads.
});

for (const usage of [null, { usedTokens: 60000, modelContextWindow: 100000, estimated: true }])
  test(`reuse starts fresh with ${usage ? "full" : "unknown"} context`, async () => {
    const f = await load();
    const first = await f.start({ kind: "design", summary: "Plan", workstream: "plan" });
    finishAll(f, first);
    f.setUsage(usage);
    const next = await f.start({
      kind: "design",
      mode: "deep",
      summary: "Follow-up",
      workstream: "plan",
    });
    expect(next.threadIds).toEqual(["thr_reviewer_3", "thr_reviewer_4"]);
    expect(next.reused).toBe(false);
  });

test("a publication helper inherits an unchanged parent's Deep assessment without spawning again", async () => {
  const f = await load();
  const request = {
    mode: "deep",
    scope: "publication",
    summary: "Publish",
    target: { branch: "scott/camera" },
  };
  const run = await f.start(request);
  await readDiff(f, run);
  finishAll(f, run);
  await f.tool("review_result", { runId: run.runId });
  const helper = Object.assign(
    makeThreadResponse({
      id: "thr_helper",
      parentThreadId: "thr_author",
      projectId: "proj_1",
      environmentId: "env_1",
      providerId: "codex",
    }),
    { environment: { id: "env_1", hostId: "host_laptop", path: "/work/repo", status: "ready" } },
  );
  f.records.set(helper.id, helper);
  expect(
    await f.tool("review_start", { ...request, summary: "Create PR" }, helper.id),
  ).toMatchObject({ runId: run.runId, cached: true, reused: true });
  expect(await f.tool("review_result", { runId: run.runId }, helper.id)).toMatchObject({
    current: true,
    deepImplementationCovered: true,
  });
  expect(f.host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  f.setHead("c".repeat(40));
  const changed = await f.tool(
    "review_start",
    { ...request, summary: "Changed candidate" },
    helper.id,
  );
  expect(changed.runId).not.toBe(run.runId);
  expect(f.host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(4);
});

test("descendants in another environment cannot inherit a parent's assessment", async () => {
  const f = await load();
  const r = await f.start({ kind: "design", summary: "Private plan" });
  f.records.set(
    "thr_other_env",
    makeThreadResponse({
      id: "thr_other_env",
      parentThreadId: "thr_author",
      projectId: "proj_1",
      environmentId: "env_2",
    }),
  );
  await expect(
    f.tool("review_context", { runId: r.runId, section: "brief" }, "thr_other_env"),
  ).rejects.toThrow("not available");
});

test("superseding an unread reviewer updates its metadata to incomplete", async () => {
  const f = await load();
  const r = await f.start({ mode: "deep", kind: "design", summary: "Initial" });
  finishAll(f, r);
  await f.start({ mode: "deep", kind: "design", summary: "Replacement", reuse: "new" });
  expect(r.threadIds.map((id: string) => f.metadata.get(id))).toMatchObject([
    { reviewRun: { seat: 0, status: "incomplete" } },
    { reviewRun: { seat: 1, status: "incomplete" } },
  ]);
});

test("CLI durations are milliseconds at the SDK wait boundary", async () => {
  const f = await load();
  const r = await f.start({ kind: "design", summary: "Plan" });
  const result = await f.cli(["result", r.runId, "--wait", "2s"]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(f.host.harness.inspection.sdk.callsTo("threads.wait")[0]?.[0]).toMatchObject({
    timeoutMs: 2000,
  });
});

test("failed reused dispatch projects failed metadata and allows a corrected retry", async () => {
  const f = await load();
  const first = await f.start({ kind: "design", summary: "Initial", workstream: "plan" });
  finishAll(f, first);
  f.setSendFailure("Invalid effort");
  await expect(
    f.start({ kind: "design", summary: "Follow-up", workstream: "plan" }),
  ).rejects.toThrow("Invalid effort");
  expect(f.metadata.get(first.threadIds[0])).toMatchObject({ reviewRun: { status: "failed" } });
  f.setSendFailure(undefined);
  expect(await f.start({ kind: "design", summary: "Corrected", workstream: "plan" })).toMatchObject(
    { status: "running" },
  );
});

test("adopted dispatch reconciles its metadata before returning busy", async () => {
  const f = await load();
  f.setSpawnFailure("Gateway timeout");
  await expect(f.start({ kind: "design", summary: "Plan" })).rejects.toThrow();
  const db = f.host.bb.storage.database();
  const row = db.prepare<[], { payload: string }>("SELECT payload FROM review_runs").get()!;
  const run = JSON.parse(row.payload);
  for (const [seat, providerId] of ["claude-code", "codex"].entries()) {
    const child = makeThreadResponse({
      id: `thr_adopted_${seat}`,
      parentThreadId: "thr_author",
      projectId: "proj_1",
      environmentId: "env_1",
      providerId,
      originPluginId: "review",
      status: "active",
    });
    f.records.set(child.id, child);
    f.metadata.set(child.id, { reviewRun: { id: run.id, seat, status: "starting" } });
  }
  f.setSpawnFailure(undefined);
  expect(await f.start({ kind: "design", summary: "Retry" })).toMatchObject({
    runId: run.id,
    threadIds: ["thr_adopted_0", "thr_adopted_1"],
    busy: true,
  });
  expect(f.metadata.get("thr_adopted_1")).toMatchObject({
    reviewRun: { id: run.id, seat: 1, status: "running" },
  });
});

test("editing the reviewer persona cannot change the run binding or output contract", async () => {
  const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const isolatedRoot = await mkdtemp(join(tmpdir(), "review-persona-"));
  try {
    await cp(join(sourceRoot, "src"), join(isolatedRoot, "src"), { recursive: true });
    await cp(join(sourceRoot, "instructions"), join(isolatedRoot, "instructions"), {
      recursive: true,
    });
    await copyFile(join(sourceRoot, "package.json"), join(isolatedRoot, "package.json"));
    await symlink(
      join(sourceRoot, "../../node_modules"),
      join(isolatedRoot, "node_modules"),
      "dir",
    );
    const path = join(isolatedRoot, "instructions/reviewer.md");
    await writeFile(path, "An editable persona preamble.\n\n" + (await readFile(path, "utf8")));
    const isolatedPlugin = (await import(join(isolatedRoot, "src/server/server.ts"))).default;
    const f = await load("codex", "gpt-6-astra", null, isolatedPlugin);
    const run = await f.start({ kind: "design", summary: "Edited persona" });
    finishAll(f, run);
    expect(await f.tool("review_result", { runId: run.runId })).toMatchObject({
      status: "complete",
      reviews: [
        { report: { status: "complete", coverage: "Checked the complete fixed candidate" } },
        { report: { status: "complete", coverage: "Checked the complete fixed candidate" } },
      ],
    });
    const prompt = (
      f.host.harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as { prompt: string }
    ).prompt;
    expect(prompt.slice(0, prompt.indexOf("\n"))).toBe(
      `Review run ${run.runId}: design, standard.`,
    );
    expect(prompt).toContain("An editable persona preamble.");
    expect(prompt).toContain(`Return only JSON: {"runId":"${run.runId}"`);
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
});

test("implementation reviewers get the rubric and code-quality lens; design reviewers do not", async () => {
  const instruction = (name: string) =>
    readFile(new URL(`../../../instructions/${name}.md`, import.meta.url), "utf8").then((text) =>
      text.trim(),
    );
  const [rubric, codeQuality] = await Promise.all([
    instruction("rubric"),
    instruction("code-quality"),
  ]);
  const promptFor = async (request: Record<string, unknown>) => {
    const f = await load();
    const run = await f.start(request);
    const [spawn] = f.host.harness.inspection.sdk.callsTo("threads.spawn")[0] as [
      { prompt: string },
    ];
    await f.host.harness.lifecycle.dispose();
    return { runId: run.runId, prompt: spawn.prompt };
  };

  const impl = await promptFor({ summary: "Check the camera", target: { branch: "scott/camera" } });
  expect(impl.prompt.slice(0, impl.prompt.indexOf("\n"))).toBe(
    `Review run ${impl.runId}: implementation, standard.`,
  );
  const contract = impl.prompt.indexOf(`Return only JSON: {"runId":"${impl.runId}"`);
  expect(impl.prompt.indexOf(rubric)).toBeGreaterThan(0);
  expect(impl.prompt.indexOf(codeQuality)).toBeGreaterThan(impl.prompt.indexOf(rubric));
  expect(contract).toBeGreaterThan(impl.prompt.indexOf(codeQuality));

  const design = await promptFor({ kind: "design", summary: "Choose a queue boundary" });
  expect(design.prompt.slice(0, design.prompt.indexOf("\n"))).toBe(
    `Review run ${design.runId}: design, standard.`,
  );
  expect(design.prompt).toContain(`Return only JSON: {"runId":"${design.runId}"`);
  expect(design.prompt).not.toContain(rubric);
  expect(design.prompt).not.toContain(codeQuality);
});

test("reading beyond EOF cannot invalidate complete Deep diff coverage", async () => {
  const f = await load();
  const run = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Publish",
    target: { branch: "scott/camera" },
  });
  await readDiff(f, run);
  await readDiff(f, run, 1000);
  finishAll(f, run);
  expect(await f.tool("review_result", { runId: run.runId })).toMatchObject({
    status: "complete",
    deepImplementationCovered: true,
    reviews: [
      { diffCoverage: { complete: true, unread: [] } },
      { diffCoverage: { complete: true, unread: [] } },
    ],
  });
});

test("reviewer reads before spawn returns count toward its Deep assessment", async () => {
  const f = await load();
  f.setBeforeSpawnReturn(async (threadId, runId) => {
    await f.tool("review_context", { runId, section: "diff" }, threadId);
  });
  const run = await f.start({
    mode: "deep",
    scope: "publication",
    summary: "Publish",
    target: { branch: "scott/camera" },
  });
  finishAll(f, run);
  expect(await f.tool("review_result", { runId: run.runId })).toMatchObject({
    status: "complete",
    deepImplementationCovered: true,
    reviews: [
      { diffCoverage: { complete: true, totalLength: 23 } },
      { diffCoverage: { complete: true, totalLength: 23 } },
    ],
  });
});

test("an author's new publication evidence is assessed rather than inherited", async () => {
  const f = await load();
  const request = {
    mode: "deep",
    scope: "publication",
    summary: "Publish",
    target: { branch: "scott/camera" },
  };
  const first = await f.start(request);
  await readDiff(f, first);
  finishAll(f, first);
  await f.tool("review_result", { runId: first.runId });
  f.setEvidence("New candidate evidence to reconsider");
  const next = await f.start({
    ...request,
    summary: "Reconsider new evidence",
    evidence: [{ label: "New evidence", path: "/tmp/new-evidence.txt" }],
  });
  expect(next.runId).not.toBe(first.runId);
  expect(next).toMatchObject({ threadIds: first.threadIds, status: "running", reused: true });
  const evidence = await f.tool(
    "review_context",
    { runId: next.runId, section: "evidence" },
    next.threadIds[1],
  );
  expect(JSON.parse(evidence.text).map((item: { text: string }) => item.text)).toEqual([
    "New candidate evidence to reconsider",
  ]);
});

test("explicit reviewer selection starts a new assessment even for the identical publication request", async () => {
  const f = await load();
  const request = {
    mode: "deep",
    scope: "publication",
    summary: "Publish",
    target: { branch: "scott/camera" },
  };
  const first = await f.start(request);
  await readDiff(f, first);
  finishAll(f, first);
  await f.tool("review_result", { runId: first.runId });
  const next = await f.start({ ...request, reuse: { threadId: first.threadIds[1] } });
  expect(next.runId).not.toBe(first.runId);
  expect(next).toMatchObject({
    threadIds: ["thr_reviewer_3", first.threadIds[1]],
    status: "running",
    reused: true,
  });
  finishAll(f, next);
  await expect(
    f.start({
      ...request,
      summary: "Quick check",
      mode: "quick",
      reuse: { threadId: first.threadIds[1] },
    }),
  ).rejects.toThrow("matches no reviewer model");
  await expect(f.start({ ...request, reuse: { threadId: "thr_author" } })).rejects.toThrow(
    "is not a reviewer from an earlier run",
  );
});
