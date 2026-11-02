import { describe, expect, test } from "bun:test";
import { traceThread, TurnEvents } from "../../test/events.ts";
import {
  assembleTurnTrace,
  ZERO_USAGE,
  type AssembleTurnTraceInput,
  type NeatlogsSpan,
  type TokenUsage,
} from "./turn-trace.ts";

const iso = (ms: number) => new Date(ms).toISOString();

function assemble(
  input: Omit<AssembleTurnTraceInput, "usageBaseline"> & { usageBaseline?: TokenUsage | null },
): NeatlogsSpan | null {
  return assembleTurnTrace({ usageBaseline: ZERO_USAGE, ...input }).trace;
}

function claudeTurn(): TurnEvents {
  return new TurnEvents("thread-1")
    .request(1_000, "Fix the flaky test")
    .started("t1", 1_500)
    .item("t1", 1_500, 1_600, { id: "r-1", type: "reasoning", content: ["secret"], summary: [] })
    .item("t1", 1_600, 1_700, { id: "m-1", type: "agentMessage", text: "Let me look." })
    .item("t1", 1_700, 2_000, {
      id: "cmd-1",
      type: "commandExecution",
      command: "bun test",
      cwd: "",
      status: "completed",
      exitCode: 0,
      aggregatedOutput: "1 fail",
    })
    .item("t1", 2_100, 2_200, {
      id: "fc-1",
      type: "fileChange",
      status: "completed",
      changes: [{ path: "src/a.ts", kind: "update", diff: "+fix" }],
    })
    .item("t1", 2_200, 2_400, { id: "m-2", type: "agentMessage", text: "Fixed it." })
    .usage("t1", 2_450, { input: 52, cached: 1_000, cacheRead: 900, output: 200, total: 1_252 })
    .completed("t1", 2_500);
}

function allSpans(span: NeatlogsSpan): NeatlogsSpan[] {
  return [span, ...(span.children ?? []).flatMap(allSpans)];
}

describe("assembleTurnTrace", () => {
  test("nests one turn as a workflow of LLM round trips and the tool calls between them", () => {
    const trace = assemble({
      contentMode: "full",
      events: claudeTurn().rows,
      thread: traceThread(),
    });

    expect(trace).toMatchObject({
      name: "bb-agent-turn",
      kind: "WORKFLOW",
      start: iso(1_000),
      end: iso(2_500),
      status: "OK",
      input: "Fix the flaky test",
      output: "Fixed it.",
      attributes: { "neatlogs.session.id": "thread-1" },
      metadata: {
        threadId: "thread-1",
        turnId: "t1",
        providerId: "claude-code",
        model: "claude-opus-5-5[1m]",
        threadTitle: "Fix the flaky test",
      },
    });
    expect(trace?.children?.map((span) => [span.kind, span.start, span.end])).toEqual([
      ["LLM", iso(1_000), iso(1_700)],
      ["TOOL", iso(1_700), iso(2_000)],
      ["LLM", iso(2_000), iso(2_100)],
      ["TOOL", iso(2_100), iso(2_200)],
      ["LLM", iso(2_200), iso(2_400)],
    ]);

    const [firstStep, command, , , lastStep] = trace?.children ?? [];
    expect(firstStep).toMatchObject({
      model: "claude-opus-5-5",
      input: [{ role: "user", content: "Fix the flaky test" }],
      output: [
        {
          role: "assistant",
          content: "Let me look.",
          tool_calls: [
            {
              id: "cmd-1",
              function: { name: "commandExecution", arguments: { command: "bun test" } },
            },
          ],
        },
      ],
    });
    expect(firstStep?.tokens).toBeUndefined();
    expect(command).toMatchObject({
      tool_name: "commandExecution",
      input: { command: "bun test" },
      output: { exitCode: 0, output: "1 fail" },
      status: "OK",
    });
    expect(lastStep).toMatchObject({
      tokens: { prompt: 1_052, completion: 200, total: 1_252 },
      attributes: {
        "neatlogs.llm.provider": "anthropic",
        "neatlogs.llm.token_count.cache_read": 900,
        "neatlogs.llm.token_count.cache_write": 100,
      },
    });
    expect(JSON.stringify(trace)).not.toContain("hidden agent instructions");
    expect(JSON.stringify(trace)).not.toContain("secret");
  });

  test("reports the turn's usage as the change in BB's cumulative total", () => {
    const events = new TurnEvents("thread-1")
      .request(1_000, "Tune the cache", "gpt-6-astra")
      .started("t1", 1_000)
      .item("t1", 1_100, 1_200, { id: "m-1", type: "agentMessage", text: "Done." })
      .usage("t1", 1_150, { input: 56_668, cached: 0, cacheRead: 0, output: 307, total: 56_975 })
      .usage("t1", 1_190, {
        input: 109_668,
        cached: 40_000,
        cacheRead: 40_000,
        output: 1_381,
        total: 111_049,
      })
      .completed("t1", 1_200);
    const before: TokenUsage = {
      ...ZERO_USAGE,
      inputTokens: 10_000,
      outputTokens: 100,
      totalTokens: 10_100,
    };
    const thread = traceThread({ providerId: "codex" });

    const { trace, usageTotal } = assembleTurnTrace({
      contentMode: "full",
      events: events.rows,
      thread,
      usageBaseline: before,
    });

    expect(trace?.children?.at(-1)).toMatchObject({
      model: "gpt-6-astra",
      tokens: { prompt: 99_668, completion: 1_281, total: 100_949 },
      attributes: {
        "neatlogs.llm.provider": "openai",
        "neatlogs.llm.token_count.cache_read": 40_000,
      },
    });
    expect(usageTotal?.totalTokens).toBe(111_049);
    // BB prunes earlier reports; without a known baseline the usage is unknown, not zero.
    const unknown = assemble({
      contentMode: "full",
      events: events.rows,
      thread,
      usageBaseline: null,
    });
    expect(unknown?.children?.some((span) => span.tokens !== undefined)).toBe(false);
  });

  test("keeps the prompt and model that started the turn when a message steers it", () => {
    const events = new TurnEvents("thread-1")
      .request(1_000, "Fix the flaky test")
      .started("t1", 1_000)
      .item("t1", 1_100, 1_200, { id: "m-1", type: "agentMessage", text: "On it." })
      .request(1_300, "Also run lint", "claude-sonnet-5-5")
      .item("t1", 1_400, 1_500, { id: "m-2", type: "agentMessage", text: "Both done." })
      .completed("t1", 1_600);

    const trace = assemble({ contentMode: "full", events: events.rows, thread: traceThread() });

    expect(trace).toMatchObject({
      start: iso(1_000),
      input: "Fix the flaky test\n\nAlso run lint",
      metadata: { model: "claude-opus-5-5[1m]" },
    });
  });

  test("orders a command reported only at completion before the round trip that follows it", () => {
    const events = new TurnEvents("thread-1")
      .request(1_000, "List files", "gpt-6-luna")
      .started("t1", 1_000)
      .item("t1", 1_500, 1_500, {
        id: "cmd-1",
        type: "commandExecution",
        command: "ls",
        cwd: "",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "README.md",
      })
      .item("t1", 1_600, 1_700, { id: "m-1", type: "agentMessage", text: "One file." })
      .completed("t1", 1_800);

    const trace = assemble({
      contentMode: "full",
      events: events.rows,
      thread: traceThread({ providerId: "codex" }),
    });

    expect(trace?.children?.map((span) => span.kind)).toEqual(["LLM", "TOOL", "LLM"]);
  });

  test("nests a subagent's calls under its delegation without splitting the parent's round trip", () => {
    const events = new TurnEvents("thread-1")
      .request(1_000, "Investigate")
      .started("t1", 1_000)
      .item("t1", 1_700, 3_000, {
        id: "del-1",
        type: "delegation",
        status: "completed",
        label: "Explore",
        background: false,
        childRef: "agent-1",
        summary: "Found it",
      })
      .item("t1", 1_800, 1_900, {
        id: "cmd-1",
        type: "commandExecution",
        parentToolCallId: "del-1",
        command: "rg flaky",
        cwd: "",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "",
      })
      .item("t1", 1_900, 2_000, {
        id: "m-sub",
        type: "agentMessage",
        parentToolCallId: "del-1",
        text: "subagent note",
      })
      .item("t1", 3_100, 3_200, { id: "m-1", type: "agentMessage", text: "Done." })
      .completed("t1", 3_300);

    const trace = assemble({
      contentMode: "full",
      events: events.rows,
      thread: traceThread(),
    });

    expect(trace?.children?.map((span) => span.kind)).toEqual(["LLM", "AGENT", "LLM"]);
    const agent = trace?.children?.[1];
    expect(agent).toMatchObject({ name: "delegation", output: "Found it" });
    expect(agent?.children?.map((span) => [span.kind, span.input])).toEqual([
      ["TOOL", { command: "rg flaky" }],
    ]);
  });

  test.each([
    ["metadata mode", "metadata" as const, "visible" as const],
    ["a hidden thread in full mode", "full" as const, "hidden" as const],
  ])("%s sends structure, timing, and usage without any content", (_, contentMode, visibility) => {
    const trace = assemble({
      contentMode,
      events: claudeTurn().rows,
      thread: traceThread({ visibility, title: "Acme Corp contract dispute" }),
    });
    if (trace === null) throw new Error("expected a trace");
    expect(JSON.stringify(trace)).not.toContain("Acme");

    for (const span of allSpans(trace)) {
      expect(span).not.toHaveProperty("input");
      expect(span).not.toHaveProperty("output");
    }
    expect(JSON.stringify(trace)).not.toContain("bun test");
    expect(trace.children?.[1]).toMatchObject({ kind: "TOOL", tool_name: "commandExecution" });
    expect(trace.children?.at(-1)?.tokens?.total).toBe(1_252);
  });

  test("marks a failed command and a failed turn as errors", () => {
    const events = new TurnEvents("thread-1")
      .request(1_000, "Run it")
      .started("t1", 1_000)
      .item("t1", 1_100, 1_200, {
        id: "cmd-1",
        type: "commandExecution",
        command: "false",
        cwd: "",
        status: "completed",
        exitCode: 1,
        aggregatedOutput: "",
      })
      .completed("t1", 1_300, "failed");

    const trace = assemble({
      contentMode: "full",
      events: events.rows,
      thread: traceThread(),
    });

    expect(trace).toMatchObject({ status: "ERROR", error: "BB turn failed" });
    expect(trace?.children?.find((span) => span.kind === "TOOL")).toMatchObject({
      status: "ERROR",
      error: "exit code 1",
    });
  });

  test("truncates long content so a busy turn stays far below the request cap", () => {
    const events = new TurnEvents("thread-1")
      .request(1_000, "Dump logs")
      .started("t1", 1_000)
      .item("t1", 1_100, 1_200, {
        id: "cmd-1",
        type: "commandExecution",
        command: "cat big.log",
        cwd: "",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "x".repeat(40_000),
      })
      .completed("t1", 1_300);

    const trace = assemble({
      contentMode: "full",
      events: events.rows,
      thread: traceThread(),
    });

    const output = JSON.stringify(trace?.children?.find((span) => span.kind === "TOOL")?.output);
    expect(output.length).toBeLessThan(17_000);
    expect(output).toContain('"truncated":true');
  });

  test("returns null for a turn that started before the window", () => {
    const events = new TurnEvents("thread-1")
      .item("t1", 1_100, 1_200, { id: "m-1", type: "agentMessage", text: "late" })
      .completed("t1", 1_300);

    expect(
      assemble({ contentMode: "full", events: events.rows, thread: traceThread() }),
    ).toBeNull();
  });
});
