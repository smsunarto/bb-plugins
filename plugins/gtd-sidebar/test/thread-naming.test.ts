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
  test("supports scoped activity titles and preserves question intent", () => {
    const prompt = renderThreadNamingPrompt("Can Monaco use TextMate?");
    assert.match(prompt, /specific task nouns first, <=48 chars, questions stay questions/u);
    assert.match(
      prompt,
      /scope \(product area\(s\) joined ' \+ '; empty if unclear; never repo\)/u,
    );
    assert.match(prompt, /review=code review; verify=running tests/u);
    assert.match(prompt, /questions\/exploration=explore; writing skills\/docs=build/u);
    assert.match(prompt, /requested work, never suggested next steps/u);
    assert.match(prompt, /Current request:\nCan Monaco use TextMate\?/u);
    assert.ok(renderThreadNamingPrompt("").length < 800);
  });

  test("includes the handoff and project instructions", () => {
    assert.match(
      renderThreadNamingPrompt("Now fix signup", "  **Fixed:** login\n\nTests pass.  "),
      /Latest handoff:\n\*\*Fixed:\*\* login\n\nTests pass\.$/u,
    );
    assert.match(
      renderThreadNamingPrompt("Fix login", "", "  Keep ticket IDs.\r\nUse [Auth].  "),
      /Project title rules:\nKeep ticket IDs\.\nUse \[Auth\]\./u,
    );
  });

  test("caps combined context even when every source is large", () => {
    const prompt = renderThreadNamingPrompt(
      "U".repeat(5_000),
      "H".repeat(5_000),
      `${"P".repeat(99)}\n`.repeat(90),
      {
        priorUserPrompt: "A".repeat(5_000),
        currentTitle: "T".repeat(5_000),
      },
    );
    const selected = prompt.match(/[UHPAT]{2,}/gu) ?? [];
    assert.ok(selected.reduce((length, section) => length + section.length, 0) <= 2_400);
    assert.match(prompt, /Current request:\nU/u);
    assert.match(prompt, /Latest handoff:\nH/u);
    assert.ok(prompt.length < 3_100);
  });

  test("keeps complete scope rules while prioritizing the current request", () => {
    const prompt = renderThreadNamingPrompt(
      "Current task ".repeat(100),
      "",
      ["Use [Auth].", "X".repeat(600), "Use [Billing]."].join("\n"),
    );
    assert.match(prompt, /Project title rules:\nUse \[Auth\]\.\nUse \[Billing\]\./u);
    assert.doesNotMatch(prompt, /XXX/u);
    assert.ok(prompt.indexOf("Current request:") < prompt.indexOf("Project title rules:"));
  });

  test("omits a duplicate task anchor", () => {
    assert.doesNotMatch(
      renderThreadNamingPrompt("Fix login", "", "", { priorUserPrompt: "Fix login" }),
      /Task anchor:/u,
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
      assert.match(firstTurn.prompt, /Latest handoff:\nFirst handoff/u);
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
      assert.match(followUp.prompt, /Latest handoff:\nLogin is fixed/u);
      assert.deepEqual(followUp.writeGuard, {
        kind: "title-unchanged",
        expectedTitle: "Fix login",
        expectedRequestSeq: 3,
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
        expectedRequestSeq: 1,
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
        assert.match(result.prompt, /Project title rules:\nPrefix titles with WEB:/u);
      }
    }
  });

  test("anchors continuation to the latest substantive request and current title", () => {
    const result = plan(
      { kind: "automatic", lastAssistantText: "Signup validation is ready for review." },
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
      assert.match(result.prompt, /Task anchor:\nNow fix signup validation/u);
      assert.match(result.prompt, /Current title:\n🐛 \[Auth\] Signup validation/u);
      assert.doesNotMatch(result.prompt, /Fix login/u);
    }
  });

  test("short followups retain their substantive subject without exact continuation wording", () => {
    const result = plan(
      {
        kind: "automatic",
        lastAssistantText: "The roles coordinate planning, coding, and review.",
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
      assert.match(result.prompt, /Task anchor:\nExplain the agent roles in Ember/u);
    }
  });

  test("new explicit requests take priority over older context", () => {
    const result = plan(
      { kind: "automatic", lastAssistantText: "The older login work is complete." },
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
      assert.equal(result.userPrompt, "Can Monaco use TextMate?");
      assert.match(result.prompt, /Classify requested work/u);
      assert.doesNotMatch(result.prompt, /Current title:/u);
      assert.ok(result.prompt.indexOf("Current request:") < result.prompt.indexOf("Task anchor:"));
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
      assert.equal(result.userPrompt, "Evaluate title accuracy vs cost");
      assert.doesNotMatch(result.prompt, /Latest handoff:|Retry this/u);
      assert.equal(result.allowedShipped, false);
    }
  });

  test("shipment eligibility requires a current standalone ship it request and success", () => {
    const cases: readonly [string, string, boolean][] = [
      ["ship it", "Shipped. Pushed to origin/main.", true],
      ["Ship it!", "✅ Pushed to origin/main.", true],
      ["ship it", "Merged into main.", true],
      ["ship it", "Ready to ship.", false],
      ["ship it", "Pushed to origin/main. Deployment failed.", false],
      ["ship it", "I have not pushed to origin/main.", false],
      ["ship it", "Would have shipped if the push succeeded.", false],
      ["ship it", 'Example: "Shipped."', false],
      ['Use ☑️ after a user says "ship it".', "Shipped. Pushed to origin/main.", false],
      ['"ship it"', "Shipped. Pushed to origin/main.", false],
      ["Now fix signup", "Shipped. Pushed to origin/main.", false],
    ];
    for (const [userPrompt, handoff, allowed] of cases) {
      const result = plan(
        { kind: "automatic", lastAssistantText: handoff },
        {
          events: [
            request(1, [{ type: "text", text: "Fix login" }]),
            request(3, [{ type: "text", text: "ship it" }]),
            request(5, [{ type: "text", text: userPrompt }]),
            completed(6),
          ],
        },
      );
      assert.equal(result.kind, "run");
      if (result.kind === "run") {
        assert.equal(result.allowedShipped, allowed, `${userPrompt}: ${handoff}`);
      }
    }
  });

  test("shipment eligibility survives continuation but resets after a new task", () => {
    for (const newTask of [false, true]) {
      const result = plan(
        { kind: "automatic", lastAssistantText: "Pushed to origin/main." },
        {
          events: [
            request(1, [{ type: "text", text: "Fix login" }]),
            request(3, [{ type: "text", text: "ship it" }]),
            ...(newTask ? [request(5, [{ type: "text", text: "Now fix signup" }])] : []),
            request(7, [{ type: "text", text: "continue" }]),
            completed(8),
          ],
        },
      );
      assert.equal(result.kind, "run");
      if (result.kind === "run") assert.equal(result.allowedShipped, !newTask);
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
  test("preserves useful scope, detail, and question punctuation", () => {
    assert.equal(
      sanitizeGeneratedTitle("  🧪 [GTD Sidebar] Title accuracy   vs cost  "),
      "🧪 [GTD Sidebar] Title accuracy vs cost",
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

  test("removes unsupported shipped status without losing the task", () => {
    const title = "☑️ [Auth] Signup validation";
    assert.equal(sanitizeGeneratedTitle(title), "[Auth] Signup validation");
    assert.equal(sanitizeGeneratedTitle(title, true), title);
  });

  test("rejects empty or prefix-only output", () => {
    for (const title of ["   ", "☑️", "🧪 [GTD Sidebar]", "[GTD + Vimium]", "♻️ [GTD] ---"]) {
      assert.equal(sanitizeGeneratedTitle(title), null, title);
    }
  });
});
