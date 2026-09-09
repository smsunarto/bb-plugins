import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { TraceIndex } from "../src/host/index.ts";
import { builtinAdapters } from "../src/shared/providers/index.ts";
import { MAX_RECORD_BYTES } from "../src/host/ingest.ts";
import {
  eventDetailSchema,
  eventPageSchema,
  rawPageSchema,
  sessionPageSchema,
  statusSchema,
} from "../src/shared/schema.ts";
import type { TraceEvent } from "../src/shared/model.ts";
import { fixtureJsonl, fixtureRecords, robustnessFixtures } from "./fixtures.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

async function setup(
  provider: "codex" | "claude-code" = "codex",
  contents = fixtureJsonl(provider),
) {
  const directory = await mkdtemp(join(tmpdir(), "bb-traces-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "sessions");
  await mkdir(root);
  const path = join(root, provider === "codex" ? "rollout-fixture.jsonl" : "fixture-session.jsonl");
  await writeFile(path, contents);
  const dataDir = join(directory, "index");
  const index = new TraceIndex({ dataDir, roots: [{ provider, path: root, enabled: true }] });
  cleanup.push(() => index.close());
  await index.scan();
  return { index, directory, dataDir, root, path };
}

function allEvents(index: TraceIndex, sessionId: string): TraceEvent[] {
  const items: TraceEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = index.events({ sessionId, cursor, limit: 7, includeUsage: true });
    eventPageSchema.parse(page);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

for (const provider of ["codex", "claude-code"] as const) {
  test(`${provider}: indexes summaries, lazy bodies, exact raw spans, evidence and call/result links`, async () => {
    const { index, path } = await setup(provider);
    statusSchema.parse(index.status());
    const sessions = sessionPageSchema.parse(index.sessions({}));
    assert.equal(sessions.items.length, 1);
    const session = sessions.items[0]!;
    assert.equal(session.provider, provider);
    assert.equal(session.title, "Fix checkout validation");
    assert.ok(session.nativeId);
    const events = allEvents(index, session.id);
    assert.equal(events.length, session.eventCount);
    assert.equal(new Set(events.map((event) => event.id)).size, events.length);
    assert.ok(
      events.some((event) =>
        event.evidence.some(
          (fact) =>
            fact.topic === "skills" &&
            fact.action === (provider === "codex" ? "requested" : "invoked"),
        ),
      ),
    );
    assert.ok(
      events.some((event) =>
        event.evidence.some((fact) => fact.topic === "sandbox" && fact.action === "blocked"),
      ),
    );
    const event = events.find((item) => item.kind === "tool_call" && item.tool?.callId)!;
    assert.ok(event);
    assert.ok(!("body" in event));
    const detail = eventDetailSchema.parse(await index.event({ eventId: event.id }));
    assert.equal(detail.sourceState, "available");
    assert.equal(detail.body?.type, "tool");
    assert.ok(detail.related.some((item) => item.kind === "tool_result"));
    let offset = 0;
    const pages: Buffer[] = [];
    do {
      const raw = rawPageSchema.parse(await index.raw({ eventId: event.id, offset, limit: 31 }));
      assert.equal(raw.state, "available");
      pages.push(Buffer.from(raw.base64, "base64"));
      offset = raw.nextOffset ?? -1;
    } while (offset >= 0);
    const bytes = await readFile(path);
    assert.deepEqual(
      Buffer.concat(pages),
      bytes.subarray(
        event.provenance.byteOffset,
        event.provenance.byteOffset + event.provenance.byteLength,
      ),
    );
  });
}

test("append checkpoints survive restarts, preserve IDs and do not index partial tails", async () => {
  const fixture = robustnessFixtures("codex");
  const { index, path, dataDir, root } = await setup("codex", fixture.partialLine);
  const sessionId = index.sessions({}).items[0]!.id;
  const before = allEvents(index, sessionId);
  assert.ok(before.length > 0);
  assert.ok(before.every((event) => event.sequence === 1));
  await appendFile(path, fixture.partialLineRemainder);
  await index.scan();
  const after = allEvents(index, sessionId);
  assert.ok(after.length > before.length);
  assert.deepEqual(
    after.slice(0, before.length).map(({ id }) => id),
    before.map(({ id }) => id),
  );
  await index.close();
  const reopened = new TraceIndex({
    dataDir,
    roots: [{ provider: "codex", path: root, enabled: true }],
  });
  cleanup.push(() => reopened.close());
  await reopened.scan();
  assert.deepEqual(
    allEvents(reopened, sessionId).map(({ id }) => id),
    after.map(({ id }) => id),
  );
  await reopened.scan({ verify: true });
  assert.equal(reopened.sessions({}).items[0]!.eventCount, after.length);
});

test("truncation and same-size rewritten bytes replace summaries and reject stale raw", async () => {
  const { index, path } = await setup();
  const session = index.sessions({}).items[0]!;
  const event = allEvents(index, session.id).find((item) =>
    item.preview.includes("Fix checkout validation"),
  )!;
  const source = await readFile(path, "utf8");
  const changed = source.replaceAll("Fix checkout validation", "Fix shipping validation");
  assert.equal(changed.length, source.length);
  await writeFile(path, changed);
  await utimes(path, new Date(0), new Date(0));
  const stale = await index.raw({ eventId: event.id });
  assert.equal(stale.state, "changed");
  assert.equal(stale.base64, "");
  await index.scan({ verify: true });
  assert.equal(index.sessions({}).items[0]!.title, "Fix shipping validation");
  assert.equal((await index.event({ eventId: event.id })).sourceState, "missing");
  await writeFile(path, `${JSON.stringify(fixtureRecords("codex")[0])}\n`);
  await index.scan();
  assert.ok(index.sessions({}).items[0]!.eventCount < session.eventCount);
  assert.equal(index.events({ sessionId: session.id, query: "shipping" }).items.length, 0);
});

test("malformed and oversized records retain exact raw access while incomplete tails wait", async () => {
  const malformed = robustnessFixtures("codex").malformedBetweenRecords;
  const { index, path } = await setup("codex", malformed);
  const sessionId = index.sessions({}).items[0]!.id;
  const bad = index
    .events({ sessionId, kind: "diagnostic" })
    .items.find((event) => event.title === "Malformed source record")!;
  assert.ok(bad);
  const raw = await index.raw({ eventId: bad.id });
  assert.equal(Buffer.from(raw.base64, "base64").toString(), "{not valid json}\n");
  const oversized = `{"type":"future_event","text":"${"x".repeat(MAX_RECORD_BYTES)}"}\n`;
  await appendFile(path, oversized);
  await index.scan();
  const large = index
    .events({ sessionId, kind: "diagnostic" })
    .items.find((event) => event.title === "Oversized source record")!;
  assert.equal(large.provenance.byteLength, Buffer.byteLength(oversized));
  assert.equal((await index.event({ eventId: large.id })).bodyTruncated, true);
  const tail = await index.raw({
    eventId: large.id,
    offset: large.provenance.byteLength - 32,
    limit: 32,
  });
  assert.equal(Buffer.from(tail.base64, "base64").toString(), oversized.slice(-32));
  assert.equal(tail.nextOffset, null);
});

test("search and filters paginate without duplicates and reject mismatched or stale cursors", async () => {
  const { index, root } = await setup();
  const session = index.sessions({}).items[0]!;
  const all = allEvents(index, session.id);
  const tools = index.events({ sessionId: session.id, kind: "tool_call" }).items;
  assert.ok(tools.length > 5);
  assert.ok(tools.every((event) => event.kind === "tool_call"));
  const search = index.events({ sessionId: session.id, query: "quantity" }).items;
  assert.ok(search.length > 0);
  const topics = index.events({ sessionId: session.id, topic: "mcp" }).items;
  assert.ok(topics.length > 0);
  assert.ok(topics.every((event) => event.evidence.some(({ topic }) => topic === "mcp")));
  assert.ok(index.sessions({ query: "restricted" }).items.some(({ id }) => id === session.id));
  assert.equal(index.sessions({ provider: "claude-code" }).items.length, 0);
  assert.equal(index.sessions({ nativeId: session.nativeId }).items.length, 1);
  const cursor = index.events({ sessionId: session.id, limit: 1 }).nextCursor!;
  assert.throws(() => index.events({ sessionId: session.id, cursor, kind: "tool_call" }), /cursor/);
  assert.throws(() => index.events({ sessionId: session.id, cursor: "not-json" }), /cursor/);
  assert.throws(() => index.events({ sessionId: session.id, limit: 100_000 }));
  const first = all[0]!;
  await assert.rejects(
    index.raw({ eventId: first.id, offset: first.provenance.byteLength + 1 }),
    /offset/,
  );
  assert.throws(
    () =>
      index.events({
        sessionId: session.id,
        cursor: Buffer.from(
          JSON.stringify({ revision: index.status().revision, query: "invalid", key: [-1, ""] }),
        ).toString("base64url"),
      }),
    /cursor/,
  );
  await writeFile(join(root, "rollout-second.jsonl"), fixtureJsonl("codex"));
  await index.scan();
  assert.doesNotThrow(() => index.events({ sessionId: session.id, cursor }));
  const page = index.sessions({ limit: 1 });
  assert.ok(page.nextCursor);
  const next = index.sessions({ limit: 1, cursor: page.nextCursor });
  assert.equal(next.items.length, 1);
  assert.notEqual(page.items[0]!.id, next.items[0]!.id);
});

test("source configuration persists and missing roots preserve cached summaries", async () => {
  const { index, root, dataDir } = await setup();
  await index.configureSources({ roots: [{ provider: "codex", path: root, enabled: false }] });
  await index.scan();
  assert.equal(index.status().roots[0]!.state, "disabled");
  await index.close();
  const reopened = new TraceIndex({ dataDir });
  cleanup.push(() => reopened.close());
  assert.equal(reopened.status().roots[0]!.enabled, false);
  await reopened.configureSources({ roots: [{ provider: "codex", path: root, enabled: true }] });
  await rm(root, { recursive: true });
  await reopened.scan();
  assert.equal(reopened.status().roots[0]!.state, "missing");
  assert.equal(reopened.sessions({}).items.length, 1);
  const event = reopened.events({ sessionId: reopened.sessions({}).items[0]!.id }).items[0]!;
  assert.equal((await reopened.raw({ eventId: event.id })).state, "missing");
  await assert.rejects(
    reopened.configureSources({ roots: [{ provider: "codex", path: "relative", enabled: true }] }),
    /absolute/,
  );
  await assert.rejects(
    reopened.configureSources({ roots: [{ provider: "unknown", path: root, enabled: true }] }),
    /Unsupported/,
  );
});

test("integrity refresh detects growing rewrites outside append probes and preserves unchanged event IDs", async () => {
  const records = Array.from({ length: 180 }, (_, index) =>
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Record ${index} ${"x".repeat(100)} before` }],
      },
    }),
  );
  const original = records.join("\n") + "\n";
  const { index, path } = await setup("codex", original);
  const sessionId = index.sessions({}).items[0]!.id;
  const before = allEvents(index, sessionId);
  const target = before.find((event) => event.sequence === 90)!;
  records[89] = records[89]!.replace("before", "after!");
  await writeFile(path, records.join("\n") + "\n" + records[0] + "\n");
  await index.scan();
  assert.equal((await index.raw({ eventId: target.id })).state, "changed");
  await index.scan({ verify: true });
  const after = allEvents(index, sessionId);
  assert.equal(after.length, before.length + 1);
  assert.equal(after[0]!.id, before[0]!.id);
  assert.notEqual(after.find((event) => event.sequence === 90)!.id, target.id);
  assert.equal(index.events({ sessionId, query: "after" }).items.length, 1);
  assert.ok(index.events({ sessionId, query: "before", limit: 200 }).items.length > 100);
});

test("changing source configuration cancels an active scan and removes abandoned source caches", async () => {
  const { index, path } = await setup();
  await appendFile(path, fixtureJsonl("codex").repeat(100));
  const scan = index.scan();
  const rejectedScan = scan.catch((error: unknown) => error);
  assert.equal(index.status().scanning, true);
  const status = await index.configureSources({ roots: [] });
  await rejectedScan;
  assert.equal(status.scanning, false);
  assert.equal(status.sessions, 0);
  assert.equal(status.events, 0);
  assert.deepEqual(index.sessions({ query: "checkout" }).items, []);
});

test("event cursors survive appends but reject a replacement generation", async () => {
  const { index, path } = await setup();
  const sessionId = index.sessions({}).items[0]!.id;
  const first = index.events({ sessionId, limit: 1 });
  assert.ok(first.nextCursor);
  await appendFile(path, `${JSON.stringify(fixtureRecords("codex")[0])}\n`);
  await index.scan();
  const next = index.events({ sessionId, cursor: first.nextCursor, limit: 1 });
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0]!.id, first.items[0]!.id);
  await writeFile(path, fixtureJsonl("codex").replaceAll("checkout", "shipping"));
  await index.scan({ verify: true });
  assert.throws(() => index.events({ sessionId, cursor: first.nextCursor }), /stale/);
});

test("raw validation cache rejects modified and atomically replaced source files", async () => {
  const { index, path, directory } = await setup();
  const sessionId = index.sessions({}).items[0]!.id;
  const event = allEvents(index, sessionId).find((item) => item.preview.includes("checkout"))!;
  assert.equal((await index.raw({ eventId: event.id, limit: 16 })).state, "available");
  const replacement = join(directory, "replacement.jsonl");
  await writeFile(replacement, fixtureJsonl("codex").replaceAll("checkout", "shipping"));
  await rename(replacement, path);
  assert.equal((await index.raw({ eventId: event.id, offset: 16, limit: 16 })).state, "changed");
  assert.equal((await index.raw({ eventId: event.id, limit: 16 })).state, "changed");
});

test("a detected rewrite during append rolls back newly visible events and checkpoint counters", async () => {
  const { index, path, root, dataDir } = await setup();
  const sessionId = index.sessions({}).items[0]!.id;
  const originalIds = allEvents(index, sessionId).map(({ id }) => id);
  await index.close();
  const appended =
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Appended fixture message" }],
      },
    }) + "\n";
  const source = fixtureJsonl("codex") + appended.repeat(700);
  await writeFile(path, source);
  const base = builtinAdapters.find(({ id }) => id === "codex")!;
  let parsed = 0;
  const adapter = {
    ...base,
    parse(record: unknown, context: { path: string; line: number }) {
      parsed += 1;
      if (parsed === 10) writeFileSync(path, source.replace("codex_cli_rs", "codex_cli_xx"));
      return base.parse(record, context);
    },
  };
  const reopened = new TraceIndex({
    dataDir,
    adapters: [adapter],
    roots: [{ provider: "codex", path: root, enabled: true }],
  });
  cleanup.push(() => reopened.close());
  await reopened.scan();
  assert.equal(reopened.status().roots[0]!.state, "error");
  assert.deepEqual(
    allEvents(reopened, sessionId).map(({ id }) => id),
    originalIds,
  );
  assert.equal(reopened.sessions({}).items[0]!.eventCount, originalIds.length);
  assert.equal(reopened.events({ sessionId, query: "Appended" }).items.length, 0);
  await reopened.scan({ verify: true });
  assert.equal(reopened.sessions({}).items[0]!.eventCount, originalIds.length + 700);
});

test("the timeline hides response usage records until a reader asks for them", async () => {
  const { index } = await setup("claude-code");
  const sessionId = index.sessions({}).items[0]!.id;
  const hidden = index.events({ sessionId, limit: 200 }).items;
  const shown = index.events({ sessionId, limit: 200, includeUsage: true }).items;
  assert.ok(shown.some((event) => event.kind === "usage"));
  assert.ok(!hidden.some((event) => event.kind === "usage"));
  assert.equal(
    index.events({ sessionId, kind: "usage", limit: 200 }).items.length,
    shown.filter((event) => event.kind === "usage").length,
  );
});

test("adapter upgrades replace cached catalog titles with the actual user prompt", async () => {
  const userMessage = (text: string) => ({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
  const contents =
    [
      fixtureRecords("codex")[0],
      userMessage(
        "<recommended_plugins>\nExample plugin catalog\n</recommended_plugins>\n" +
          "# AGENTS.md instructions for /workspace/shop\n<INSTRUCTIONS>Repository rules</INSTRUCTIONS>\n" +
          "<environment_context><cwd>/workspace/shop</cwd></environment_context>",
      ),
      userMessage("Fix checkout validation"),
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n";
  const { index, path, dataDir, root } = await setup("codex", contents);
  await index.close();
  const current = builtinAdapters.find(({ id }) => id === "codex")!;
  const previous = new TraceIndex({
    dataDir,
    roots: [{ provider: "codex", path: root, enabled: true }],
    adapters: [
      {
        ...current,
        version: current.version - 1,
        parse(record, context) {
          const parsed = current.parse(record, context);
          if (context.line === 2) parsed.session.title = "<recommended_plugins>";
          return parsed;
        },
      },
    ],
  });
  cleanup.push(() => previous.close());
  await previous.scan();
  assert.equal(previous.sessions({}).items[0]!.title, "<recommended_plugins>");
  await previous.close();

  const upgraded = new TraceIndex({
    dataDir,
    roots: [{ provider: "codex", path: root, enabled: true }],
  });
  cleanup.push(() => upgraded.close());
  await upgraded.scan();
  assert.equal(upgraded.sessions({}).items[0]!.title, "Fix checkout validation");
  assert.equal(await readFile(path, "utf8"), contents);
});
