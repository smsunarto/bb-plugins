import { describe, expect, it } from "vitest";
import { lastMessage, MESSAGE_CHARS, pendingAsk, previewText, threadActivityLabel, workersByParent } from "./thread-activity";

/** A provider interaction as BB's threads.interactions.list returns it (SDK `ProviderPendingInteraction`). */
function provider(payload: object, overrides: object = {}) {
  return {
    id: "pi_1",
    createdAt: 100,
    providerId: "claude-code",
    providerRequestId: "req_1",
    providerThreadId: "pt_1",
    payload,
    resolution: null,
    resolvedAt: null,
    status: "pending",
    statusReason: null,
    threadId: "thr_lane01",
    turnId: "turn_1",
    ...overrides,
  };
}

describe("lastMessage", () => {
  it("keeps a short message whole and says when there is none", () => {
    expect(lastMessage("  Fixed and live: `main` = `production`.\n")).toEqual({ text: "Fixed and live: `main` = `production`.", truncated: false });
    expect(lastMessage(null)).toBeNull();
    expect(lastMessage("   \n")).toBeNull();
    expect(lastMessage(undefined)).toBeNull();
  });

  it("cuts a long message at a word and closes a code fence it cut open", () => {
    const long = `Result:\n\n\`\`\`\n${"word ".repeat(600)}\n\`\`\`\nAfter.`;
    const kept = lastMessage(long);
    expect(kept?.truncated).toBe(true);
    expect(kept!.text.length).toBeLessThanOrEqual(MESSAGE_CHARS + 4);
    expect(kept!.text.endsWith("word\n```")).toBe(true);
  });
});

describe("previewText", () => {
  it("reads a real status report as one plain line", () => {
    // The start of a thread output (bb thread output thr_d9k2e7sq5b).
    const output =
      "Fixed and live: `main` = `production` = `822e987`, Worker `8aae65f1`, smoke 17/17.\n\n**Cause** (not the palette): `flowerFragment` flipped the [normal](https://x.dev/a).";
    expect(previewText(output)).toBe(
      "Fixed and live: main = production = 822e987, Worker 8aae65f1, smoke 17/17. Cause (not the palette): flowerFragment flipped the normal.",
    );
  });

  it("drops code blocks, headings, list and quote markers, tables and images; keeps snake_case", () => {
    const markdown = "## Summary\n\n- [x] ran `npm test`\n- wrote some_file_name.ts\n> quoted\n\n```ts\nconst a = 1;\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n![shot](x.png) done";
    expect(previewText(markdown)).toBe("Summary ran npm test wrote some_file_name.ts quoted a b 1 2 done");
  });

  it("caps a huge message", () => {
    expect(previewText("a ".repeat(1_000)).length).toBeLessThanOrEqual(400);
  });
});

describe("pendingAsk", () => {
  it("shows a question with its options, and more questions in the same ask", () => {
    const ask = pendingAsk([
      provider({
        kind: "user_question",
        questions: [
          {
            id: "q1",
            prompt: "Which branch should I install, 399 or main?",
            allowFreeText: true,
            multiSelect: false,
            options: [
              { label: "feat/399", value: "399" },
              { label: "main", value: "main" },
            ],
          },
          { id: "q2", prompt: "Cold start?", allowFreeText: false, multiSelect: false },
        ],
      }),
    ]);
    expect(ask).toEqual({
      kind: "question",
      action: "Answer 2 questions",
      text: "Which branch should I install, 399 or main?",
      code: false,
      options: ["feat/399", "main"],
      more: 1,
      since: 100,
    });
  });

  it("names what an approval would do: a command, file changes, a permission, a plan, a tool", () => {
    const command = { kind: "command", command: "xcrun devicectl device install app --device 0000 build/Orbit.app", cwd: "/repo", itemId: "i", actions: [], sessionGrant: null };
    const approval = (subject: object) => pendingAsk([provider({ kind: "approval", availableDecisions: ["allow_once", "deny"], reason: null, subject })]);
    expect(approval(command)).toMatchObject({ kind: "approval", action: "Approve running a command", text: command.command, code: true });
    expect(approval({ kind: "file_change", itemId: "i", sessionGrant: null, writeScope: "/repo/src" })).toMatchObject({ action: "Approve file changes", text: "In /repo/src" });
    expect(
      approval({ kind: "permission_grant", itemId: "i", toolName: null, permissions: { fileSystem: { read: [], write: ["/tmp/out"] }, network: { enabled: true } } }),
    ).toMatchObject({ action: "Grant a permission", text: "write /tmp/out · network access" });
    expect(approval({ kind: "plan", itemId: "i", plan: "## Plan\n\n1. Build on the Mac\n2. Install", planFilePath: null })).toMatchObject({
      kind: "plan",
      action: "Approve a plan",
      text: "Plan Build on the Mac Install",
    });
    expect(
      approval({ kind: "tool_use", itemId: "i", tool: "WebFetch", presentation: { icon: { glyph: "Globe" }, label: { pending: "Fetching docs.bb.dev", completed: "Fetched" } } }),
    ).toMatchObject({ action: "Approve using WebFetch", text: "Fetching docs.bb.dev" });
  });

  it("reads a real plugin request (the secrets plugin's form)", () => {
    // A row of BB's pending_interactions table, as the SDK returns it.
    const ask = pendingAsk([
      {
        id: "pi_s",
        createdAt: 50,
        origin: { kind: "plugin", pluginId: "secrets", rendererId: "secret-request" },
        payload: {
          kind: "plugin",
          title: "Add secrets",
          data: { purpose: "Push the edited Orbit email templates to the mail provider", fields: [{ name: "MAIL_API_KEY" }] },
          presentation: { label: { pending: "Requesting MAIL_API_KEY", completed: "Requested MAIL_API_KEY" }, icon: { glyph: "Lock" } },
        },
        resolution: null,
        resolvedAt: null,
        status: "pending",
        statusReason: null,
        threadId: "thr_x3r6g1lh8c",
        turnId: null,
      },
    ]);
    expect(ask).toMatchObject({ kind: "request", action: "Add secrets", text: "Requesting MAIL_API_KEY", more: 0, since: 50 });
  });

  it("takes the oldest pending interaction, counts the others, and ignores resolved or unknown ones", () => {
    const question = (prompt: string, createdAt: number, status = "pending") =>
      provider({ kind: "user_question", questions: [{ id: "q", prompt, allowFreeText: true, multiSelect: false }] }, { createdAt, status });
    const ask = pendingAsk([question("Newer?", 300), question("Answered", 50, "resolved"), question("Older?", 200), { status: "pending" }]);
    expect(ask).toMatchObject({ text: "Older?", more: 2 });
    expect(pendingAsk([question("Done", 1, "resolved"), question("Stopped", 2, "interrupted")])).toBeNull();
    expect(pendingAsk([])).toBeNull();
    expect(pendingAsk("nonsense")).toBeNull();
  });
});

describe("workers", () => {
  it("counts running threads per parent", () => {
    expect(workersByParent(["thr_a", null, "thr_a", "thr_b"])).toEqual(new Map([["thr_a", 2], ["thr_b", 1]]));
  });

  it("says an idle parent waits on its running workers, and nothing else changes", () => {
    const thread = { status: "idle", needsInput: false, archived: false, runningWorkers: 1 } as const;
    expect(threadActivityLabel(thread)).toBe("Waiting on 1 running worker");
    expect(threadActivityLabel({ ...thread, runningWorkers: 3 })).toBe("Waiting on 3 running workers");
    expect(threadActivityLabel({ ...thread, runningWorkers: 0 })).toBe("Idle");
    expect(threadActivityLabel({ ...thread, needsInput: true })).toBe("Needs input");
    expect(threadActivityLabel({ ...thread, status: "active" })).toBe("Running");
    expect(threadActivityLabel({ ...thread, archived: true })).toBe("Archived");
  });
});
