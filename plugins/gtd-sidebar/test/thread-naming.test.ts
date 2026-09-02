import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import {
  normalizeInitialUserPrompt,
  planThreadNaming,
  renderThreadNamingPrompt,
  sanitizeGeneratedTitle,
  type NamingIntent,
  type NamingThreadFacts,
  type ThreadNamingEvent,
} from "../lib/thread-naming.ts";

const thread: NamingThreadFacts = {
  archivedAt: null,
  deletedAt: null,
  originPluginId: null,
  parentThreadId: null,
  title: null,
  visibility: "visible",
};

const request = (
  seq: number,
  input: Extract<ThreadNamingEvent, { type: "client/turn/requested" }>["data"]["input"],
  overrides: Partial<Extract<ThreadNamingEvent, { type: "client/turn/requested" }>["data"]> = {},
): ThreadNamingEvent => ({
  seq,
  type: "client/turn/requested",
  data: {
    initiator: "user",
    input,
    target: { kind: "thread-start" },
    ...overrides,
  },
});

const completed = (seq: number): ThreadNamingEvent => ({ seq, type: "turn/completed" });

function plan(
  intent: NamingIntent,
  overrides: {
    automaticallyNameThreads?: boolean;
    events?: readonly ThreadNamingEvent[];
    thread?: Partial<NamingThreadFacts>;
  } = {},
) {
  return planThreadNaming({
    automaticallyNameThreads: overrides.automaticallyNameThreads ?? true,
    events: overrides.events ?? [
      request(1, [{ type: "text", text: "Fix the login test" }]),
      completed(2),
    ],
    intent,
    pluginId: "gtd-sidebar",
    thread: { ...thread, ...overrides.thread },
  });
}

describe("normalizeInitialUserPrompt", () => {
  test("uses the first visible user thread-start text", () => {
    const events: ThreadNamingEvent[] = [
      request(8, [{ type: "text", text: "later" }]),
      request(2, [
        { type: "text", text: "  Fix\n  the " },
        { type: "image" },
        { type: "text", text: " hidden ", visibility: "agent-only" },
        { type: "text", text: " login\t test " },
      ]),
      request(1, [{ type: "text", text: "system" }], { initiator: "system" }),
      request(3, [{ type: "text", text: "follow-up" }], { target: { kind: "new-turn" } }),
    ];

    assert.equal(normalizeInitialUserPrompt(events), "Fix the login test");
  });

  test("caps normalized input at 4,000 characters", () => {
    const prompt = normalizeInitialUserPrompt([
      request(1, [{ type: "text", text: "x".repeat(4_100) }]),
    ]);

    assert.equal(prompt.length, 4_000);
  });
});

describe("renderThreadNamingPrompt", () => {
  test("pins bb's thread-title prompt plus the sentence-case rule", () => {
    assert.equal(
      renderThreadNamingPrompt("Fix the login test"),
      `You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.
The task usually has to do with coding work, such as fixing a bug, changing a feature, or answering a question about a codebase.
Generate a concise UI title of at most 36 characters.
Use a single line of plain text only.
Do not include quotes, markdown, formatting characters, or trailing punctuation.
Use sentence case: capitalize only the first word, proper nouns, and identifiers. Do not use Title Case.
If the prompt includes a ticket reference, include it verbatim.
Prefer an imperative verb when the user is asking for a change.
Do not answer the user or attempt the task.

User prompt:
Fix the login test`,
    );
  });
});

describe("planThreadNaming", () => {
  test("runs automatic naming only after exactly one completed turn", () => {
    assert.equal(plan({ kind: "automatic" }).kind, "run");
    assert.deepEqual(plan({ kind: "automatic" }, { events: [] }), {
      kind: "skip",
      reason: "completed-turn-count",
    });
    assert.deepEqual(
      plan(
        { kind: "automatic" },
        {
          events: [request(1, [{ type: "text", text: "Fix it" }]), completed(2), completed(3)],
        },
      ),
      { kind: "skip", reason: "completed-turn-count" },
    );
  });

  test("protects manual titles during automatic naming", () => {
    assert.deepEqual(plan({ kind: "automatic" }, { thread: { title: "Hand title" } }), {
      kind: "skip",
      reason: "title-already-set",
    });
  });

  test("lets forced naming replace an archived hand title", () => {
    const result = plan(
      { kind: "forced" },
      {
        thread: { archivedAt: 1, title: "Hand title" },
        events: [request(1, [{ type: "text", text: "Fix it" }])],
      },
    );

    assert.equal(result.kind, "run");
    if (result.kind === "run") assert.deepEqual(result.writeGuard, { kind: "replace-title" });
  });

  test("refuses hidden, child, deleted, and plugin-worker threads", () => {
    const cases: readonly [Partial<NamingThreadFacts>, string][] = [
      [{ visibility: "hidden" }, "hidden-thread"],
      [{ parentThreadId: "parent" }, "child-thread"],
      [{ deletedAt: 1 }, "deleted-thread"],
      [{ originPluginId: "gtd-sidebar" }, "plugin-worker"],
    ];

    for (const [facts, reason] of cases) {
      assert.deepEqual(plan({ kind: "forced" }, { thread: facts }), { kind: "skip", reason });
    }
  });

  test("allows threads created by another plugin", () => {
    assert.equal(
      plan({ kind: "forced" }, { thread: { originPluginId: "another-plugin" } }).kind,
      "run",
    );
  });
});

describe("sanitizeGeneratedTitle", () => {
  test("matches bb's 36-character sanitizer", () => {
    assert.equal(
      sanitizeGeneratedTitle("Investigate Extremely Long Generated Thread Title Output"),
      "Investigate Extremely Long Generated",
    );
    assert.equal(sanitizeGeneratedTitle("   "), null);
    assert.equal(sanitizeGeneratedTitle('  Keep   "quotes".  '), 'Keep "quotes".');
    assert.equal(sanitizeGeneratedTitle("x".repeat(40)), "x".repeat(36));
  });
});
