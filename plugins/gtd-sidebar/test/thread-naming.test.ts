import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import {
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
    thread: { ...thread, ...overrides.thread },
  });
}

describe("renderThreadNamingPrompt", () => {
  test("generation prompt names the request without reviewing a previous title", () => {
    const prompt = renderThreadNamingPrompt("Can Monaco use TextMate?", "", {
      currentTitle: "BB internal title",
      allowKeep: false,
    });
    assert.match(prompt, /^Generate a thread title for the current request/u);
    assert.match(prompt, /Return action "rename" and title/u);
    assert.match(prompt, /No activity emoji or status markers/u);
    assert.match(prompt, /Use a plain title unless the project title rules specify/u);
    assert.match(prompt, /Current request:\nCan Monaco use TextMate\?/u);
    assert.doesNotMatch(prompt, /keep|BB internal title|Current title:|Mode:/u);
  });

  test("review prompt preserves the task identity and includes project rules", () => {
    const prompt = renderThreadNamingPrompt("Fix login", "  Keep ticket IDs.\r\nUse [Auth].  ", {
      currentTitle: "Fix authentication",
      allowKeep: true,
    });
    assert.match(prompt, /^Keep the current thread title/u);
    assert.match(prompt, /When uncertain, keep it/u);
    assert.match(prompt, /Current title:\nFix authentication/u);
    assert.match(prompt, /Project title rules:\nKeep ticket IDs\.\nUse \[Auth\]\./u);
    assert.doesNotMatch(prompt, /first user request|forced mode|Mode:/u);
  });

  test("caps context and preserves the title even with large requests", () => {
    const prompt = renderThreadNamingPrompt("U".repeat(5_000), `${"P".repeat(99)}\n`.repeat(90), {
      initialUserPrompt: "A".repeat(5_000),
      currentTitle: "T".repeat(5_000),
      allowKeep: true,
      recentUserPrompts: Array.from({ length: 5 }, () => "R".repeat(5_000)),
    });
    const selected = prompt.match(/[UPATR]{2,}/gu) ?? [];
    assert.ok(selected.reduce((length, section) => length + section.length, 0) <= 2_400);
    assert.match(prompt, /Current title:\nT{96}\n/u);
    assert.match(prompt, /Recent requests \(oldest first\):\nR/u);
  });

  test("keeps whole scope rules and omits duplicate original request", () => {
    const prompt = renderThreadNamingPrompt(
      "Fix login",
      ["Use [Auth].", "X".repeat(600), "Use [Billing]."].join("\n"),
      { initialUserPrompt: "Fix login" },
    );
    assert.match(prompt, /Project title rules:\nUse \[Auth\]\.\nUse \[Billing\]\./u);
    assert.doesNotMatch(prompt, /XXX|Original request:/u);
  });
});

describe("normalizeProjectTitleInstructions", () => {
  test("normalizes line endings and caps instructions at 8,000 characters", () => {
    assert.equal(normalizeProjectTitleInstructions("  first\r\nsecond\r  "), "first\nsecond");
    assert.equal(normalizeProjectTitleInstructions("x".repeat(8_100)).length, 8_000);
  });
});

describe("planThreadNaming", () => {
  test("normalizes visible text without passing agent-only input to inference", () => {
    const result = plan(
      { kind: "automatic" },
      {
        events: [
          request(1, [
            { type: "text", text: "  Fix\n the " },
            { type: "image" },
            { type: "text", text: "private context", visibility: "agent-only" },
            { type: "text", text: "login\t test " },
          ]),
        ],
      },
    );
    assert.equal(result.kind, "run");
    if (result.kind === "run") {
      assert.match(result.prompt, /Current request:\nFix the login test/u);
      assert.doesNotMatch(result.prompt, /private context/u);
    }
  });

  test("runs automatic naming on initial and follow-up prompts before completion", () => {
    const firstTurn = plan({ kind: "automatic" });
    assert.equal(firstTurn.kind, "run");
    if (firstTurn.kind === "run") {
      assert.doesNotMatch(firstTurn.prompt, /Latest handoff:/u);
    }
    assert.deepEqual(plan({ kind: "automatic" }, { events: [] }), {
      kind: "skip",
      reason: "missing-user-prompt",
    });
    assert.equal(
      plan(
        { kind: "automatic" },
        {
          events: [request(1, [{ type: "text", text: "Fix it" }])],
        },
      ).kind,
      "run",
    );

    const followUp = plan(
      { kind: "automatic" },
      {
        events: [
          request(1, [{ type: "text", text: "Fix login" }]),
          completed(2),
          request(3, [{ type: "text", text: "Now fix signup" }], {
            target: { kind: "new-turn" },
          }),
        ],
        thread: { title: "Fix login" },
      },
    );
    assert.equal(followUp.kind, "run");
    if (followUp.kind === "run") {
      assert.match(followUp.prompt, /Current request:\nNow fix signup/u);
      assert.doesNotMatch(followUp.prompt, /Latest handoff:/u);
      assert.deepEqual(followUp.writeGuard, {
        kind: "title-unchanged",
        expectedTitle: "Fix login",
        expectedRequestSeq: 3,
      });
    }
  });

  test("ignores an existing BB title on the first request", () => {
    const result = plan({ kind: "automatic" }, { thread: { title: "Previous title" } });

    assert.equal(result.kind, "run");
    if (result.kind === "run") {
      assert.deepEqual(result.writeGuard, {
        kind: "initial-title",
        expectedRequestSeq: 1,
      });
    }
  });

  test("first user request replaces BB's title, later requests may keep it", () => {
    const first = plan({ kind: "automatic" }, { thread: { title: "BB internal title" } });
    assert.equal(first.kind, "run");
    if (first.kind === "run") {
      assert.equal(first.allowKeep, false);
      assert.match(first.prompt, /^Generate a thread title/u);
      assert.doesNotMatch(first.prompt, /BB internal title|Current title:/u);
    }
    const followup = plan(
      { kind: "automatic" },
      {
        thread: { title: "GTD title" },
        events: [
          request(1, [{ type: "text", text: "Build CSV export" }]),
          request(2, [{ type: "text", text: "add test" }]),
        ],
      },
    );
    assert.equal(followup.kind, "run");
    if (followup.kind === "run") {
      assert.equal(followup.allowKeep, true);
      assert.match(followup.prompt, /^Keep the current thread title/u);
      assert.match(followup.prompt, /Current title:\nGTD title/u);
    }
  });

  test("adds project instructions to automatic and forced naming", () => {
    for (const intent of [{ kind: "automatic" } as const, { kind: "forced" } as const]) {
      const result = planThreadNaming({
        automaticallyNameThreads: true,
        events: [request(1, [{ type: "text", text: "Fix it" }]), completed(2)],
        intent,
        projectInstructions: "Prefix titles with WEB:",
        thread,
      });

      assert.equal(result.kind, "run");
      if (result.kind === "run") {
        assert.match(result.prompt, /Project title rules:\nPrefix titles with WEB:/u);
      }
    }
  });

  test("anchors continuation to the latest substantive request and current title", () => {
    const result = plan(
      { kind: "automatic" },
      {
        events: [
          request(1, [{ type: "text", text: "Fix login" }]),
          request(3, [{ type: "text", text: "Now fix signup validation" }]),
          request(5, [{ type: "text", text: "continue" }]),
          request(7, [{ type: "text", text: "do it" }]),
          completed(8),
        ],
        thread: { title: "🐛 [Auth] Signup validation" },
      },
    );

    assert.equal(result.kind, "run");
    if (result.kind === "run") {
      assert.match(result.prompt, /Current request:\ndo it/u);
      assert.match(
        result.prompt,
        /Recent requests \(oldest first\):\nNow fix signup validation\ncontinue/u,
      );
      assert.match(result.prompt, /Current title:\n🐛 \[Auth\] Signup validation/u);
      assert.match(result.prompt, /Original request:\nFix login/u);
    }
  });

  test("short followups retain their substantive subject without exact continuation wording", () => {
    const result = plan(
      {
        kind: "automatic",
      },
      {
        events: [
          request(1, [{ type: "text", text: "Explain the agent roles in Ember" }]),
          request(3, [{ type: "text", text: "Give me a short summary of each role" }]),
          completed(4),
        ],
      },
    );
    assert.equal(result.kind, "run");
    if (result.kind === "run") {
      assert.match(result.prompt, /Current request:\nGive me a short summary of each role/u);
      assert.match(result.prompt, /Original request:\nExplain the agent roles in Ember/u);
    }
  });

  test("new explicit requests take priority over older context", () => {
    const result = plan(
      { kind: "automatic" },
      {
        events: [
          request(1, [{ type: "text", text: "Fix login" }]),
          request(3, [{ type: "text", text: "Can Monaco use TextMate?" }]),
          completed(4),
        ],
        thread: { title: "🐛 [Auth] Login" },
      },
    );

    assert.equal(result.kind, "run");
    if (result.kind === "run") {
      assert.match(result.prompt, /Current request:\nCan Monaco use TextMate\?/u);
      assert.match(result.prompt, /clear change of task/u);
      assert.match(result.prompt, /Current title:\n🐛 \[Auth\] Login/u);
      assert.ok(
        result.prompt.indexOf("Current request:") < result.prompt.indexOf("Original request:"),
      );
    }
  });

  test("forced naming uses the latest original user request without a handoff", () => {
    const result = plan(
      { kind: "forced" },
      {
        events: [
          request(1, [{ type: "text", text: "Configure Cloudflare" }]),
          request(3, [{ type: "text", text: "Evaluate title accuracy vs cost" }]),
          request(4, [{ type: "text", text: "Retry this" }], { retryOfRequestId: "req_3" }),
          request(5, [{ type: "text", text: "Agent continuation" }], { initiator: "agent" }),
        ],
      },
    );

    assert.equal(result.kind, "run");
    if (result.kind === "run") {
      assert.match(result.prompt, /Current request:\nEvaluate title accuracy vs cost/u);
      assert.doesNotMatch(result.prompt, /Latest handoff:|Retry this/u);
      assert.match(result.prompt, /^Generate a thread title/u);
      assert.doesNotMatch(result.prompt, /Current title:|Return action "keep"/u);
    }
  });

  test("retains task context for natural continuations and long follow-ups", () => {
    for (const text of [
      "ok lets continue indexing",
      "add test",
      "ship it",
      "More details ".repeat(20),
    ]) {
      const result = plan(
        { kind: "automatic" },
        {
          events: [
            request(1, [{ type: "text", text: "Index Pokémon" }]),
            request(2, [{ type: "text", text: "git init" }]),
            request(3, [{ type: "text", text }]),
          ],
          thread: { title: "Pokémon indexing" },
        },
      );
      assert.equal(result.kind, "run");
      if (result.kind === "run") {
        assert.match(result.prompt, /Current title:\nPokémon indexing/u);
        assert.match(result.prompt, /Original request:\nIndex Pokémon/u);
        assert.match(result.prompt, /Recent requests \(oldest first\):\ngit init/u);
      }
    }
  });

  test("skips agent continuations and retries", () => {
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
      assert.deepEqual(plan({ kind: "automatic" }, { events }), {
        kind: "skip",
        reason: "latest-turn-not-user",
      });
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

  test("refuses hidden, child, and deleted threads", () => {
    const cases: readonly [Partial<NamingThreadFacts>, string][] = [
      [{ visibility: "hidden" }, "hidden-thread"],
      [{ parentThreadId: "parent" }, "child-thread"],
      [{ deletedAt: 1 }, "deleted-thread"],
    ];

    for (const [facts, reason] of cases) {
      assert.deepEqual(plan({ kind: "forced" }, { thread: facts }), { kind: "skip", reason });
    }
  });
});

describe("sanitizeGeneratedTitle", () => {
  test("preserves useful scope, detail, and question punctuation", () => {
    assert.equal(
      sanitizeGeneratedTitle("  🧪 [GTD Sidebar] Title accuracy   vs cost  "),
      "[GTD Sidebar] Title accuracy vs cost",
    );
    assert.equal(
      sanitizeGeneratedTitle("[Monaco] Can TextMate work?"),
      "[Monaco] Can TextMate work?",
    );
    assert.equal(sanitizeGeneratedTitle('  Keep   "quotes".  '), 'Keep "quotes".');
  });

  test("enforces a grapheme-safe defensive cap", () => {
    const grapheme = "👩🏽‍💻";
    assert.equal(
      sanitizeGeneratedTitle(`Task ${grapheme.repeat(100)}`),
      `Task ${grapheme.repeat(91)}`,
    );
    assert.equal(sanitizeGeneratedTitle("e\u0301".repeat(100)), "e\u0301".repeat(96));
    assert.equal(sanitizeGeneratedTitle("x".repeat(100)), "x".repeat(96));
  });

  test("removes generated activity prefixes without losing the task", () => {
    for (const emoji of ["☑️", "🛠️", "🔎", "⚙️", "🐛", "🧪", "📦", "♻️", "🚀", "📝"]) {
      assert.equal(
        sanitizeGeneratedTitle(`${emoji} [Auth] Signup validation`),
        "[Auth] Signup validation",
      );
    }
  });

  test("rejects empty or prefix-only output", () => {
    for (const title of ["   ", "☑️", "🧪 [GTD Sidebar]", "[GTD + Vimium]", "♻️ [GTD] ---"]) {
      assert.equal(sanitizeGeneratedTitle(title), null, title);
    }
  });
});
