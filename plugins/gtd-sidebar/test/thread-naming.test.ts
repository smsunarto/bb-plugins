import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import {
  normalizeInitialUserPrompt,
  normalizeProjectTitleInstructions,
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

  test("includes the agent handoff after a follow-up prompt", () => {
    assert.match(
      renderThreadNamingPrompt("Now fix signup", "  **Fixed:** login\n\nTests pass.  "),
      /User prompt:\nNow fix signup\n\nUse the agent's last turn handoff message to understand the current task state\.\n\nAgent's last turn handoff message:\n\*\*Fixed:\*\* login\n\nTests pass\.$/u,
    );
  });

  test("injects project-specific instructions before the user prompt", () => {
    assert.equal(
      renderThreadNamingPrompt(
        "Fix the login test",
        "",
        "  Start every title with `API:`.\r\nKeep ticket IDs.  ",
      ),
      `You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.
The task usually has to do with coding work, such as fixing a bug, changing a feature, or answering a question about a codebase.
Generate a concise UI title of at most 36 characters.
Use a single line of plain text only.
Do not include quotes, markdown, formatting characters, or trailing punctuation.
Use sentence case: capitalize only the first word, proper nouns, and identifiers. Do not use Title Case.
If the prompt includes a ticket reference, include it verbatim.
Prefer an imperative verb when the user is asking for a change.
Do not answer the user or attempt the task.

Project-specific title instructions:
Start every title with \`API:\`.
Keep ticket IDs.

User prompt:
Fix the login test`,
    );
  });
});

describe("normalizeProjectTitleInstructions", () => {
  test("normalizes line endings and caps instructions at 8,000 characters", () => {
    assert.equal(normalizeProjectTitleInstructions("  first\r\nsecond\r  "), "first\nsecond");
    assert.equal(normalizeProjectTitleInstructions("x".repeat(8_100)).length, 8_000);
  });
});

describe("planThreadNaming", () => {
  test("runs automatic naming after every completed user turn", () => {
    const firstTurn = plan({ kind: "automatic", lastAssistantText: "First handoff" });
    assert.equal(firstTurn.kind, "run");
    if (firstTurn.kind === "run") {
      assert.doesNotMatch(firstTurn.prompt, /Agent's last turn handoff message/u);
    }
    assert.deepEqual(plan({ kind: "automatic", lastAssistantText: null }, { events: [] }), {
      kind: "skip",
      reason: "missing-user-prompt",
    });
    assert.deepEqual(
      plan(
        { kind: "automatic", lastAssistantText: null },
        {
          events: [request(1, [{ type: "text", text: "Fix it" }])],
        },
      ),
      { kind: "skip", reason: "latest-turn-incomplete" },
    );

    const followUp = plan(
      { kind: "automatic", lastAssistantText: "Login is fixed and tests pass." },
      {
        events: [
          request(1, [{ type: "text", text: "Fix login" }]),
          completed(2),
          request(3, [{ type: "text", text: "Now fix signup" }], {
            target: { kind: "new-turn" },
          }),
          completed(4),
        ],
        thread: { title: "Fix login" },
      },
    );
    assert.equal(followUp.kind, "run");
    if (followUp.kind === "run") {
      assert.equal(followUp.userPrompt, "Now fix signup");
      assert.match(followUp.prompt, /Agent's last turn handoff message:\nLogin is fixed/u);
      assert.deepEqual(followUp.writeGuard, {
        kind: "title-unchanged",
        expectedTitle: "Fix login",
      });
    }
  });

  test("plans to replace an unchanged existing title", () => {
    const result = plan(
      { kind: "automatic", lastAssistantText: null },
      { thread: { title: "Previous title" } },
    );

    assert.equal(result.kind, "run");
    if (result.kind === "run") {
      assert.deepEqual(result.writeGuard, {
        kind: "title-unchanged",
        expectedTitle: "Previous title",
      });
    }
  });

  test("adds project instructions to automatic and forced naming", () => {
    for (const intent of [
      { kind: "automatic", lastAssistantText: null } as const,
      { kind: "forced" } as const,
    ]) {
      const result = planThreadNaming({
        automaticallyNameThreads: true,
        events: [request(1, [{ type: "text", text: "Fix it" }]), completed(2)],
        intent,
        pluginId: "gtd-sidebar",
        projectInstructions: "Prefix titles with WEB:",
        thread,
      });

      assert.equal(result.kind, "run");
      if (result.kind === "run") {
        assert.match(
          result.prompt,
          /Project-specific title instructions:\nPrefix titles with WEB:/u,
        );
      }
    }
  });

  test("skips idle transitions not caused by an original user prompt", () => {
    const cases: ThreadNamingEvent[][] = [
      [
        request(1, [{ type: "text", text: "Fix it" }]),
        completed(2),
        request(3, [{ type: "text", text: "Continue" }], {
          initiator: "agent",
          target: { kind: "new-turn" },
        }),
        completed(4),
      ],
      [
        request(1, [{ type: "text", text: "Fix it" }]),
        completed(2),
        request(3, [{ type: "text", text: "Fix it again" }], {
          retryOfRequestId: "req_1",
          target: { kind: "auto" },
        }),
        completed(4),
      ],
    ];

    for (const events of cases) {
      assert.deepEqual(
        plan({ kind: "automatic", lastAssistantText: "Agent handoff" }, { events }),
        { kind: "skip", reason: "latest-turn-not-user" },
      );
    }
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
