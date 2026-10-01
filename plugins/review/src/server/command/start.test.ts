import { expect, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

function authorEvents(model: string) {
  return [
    {
      seq: 1,
      type: "client/turn/requested",
      data: { requestId: "req_author", execution: { model } },
    },
    { seq: 2, type: "turn/started", scope: { kind: "turn", turnId: "turn_author" }, data: {} },
    {
      seq: 3,
      type: "turn/input/accepted",
      scope: { kind: "turn", turnId: "turn_author" },
      data: { clientRequestId: "req_author" },
    },
  ];
}

async function load(
  author: { providerId: string; model: string; originPluginId?: string },
  settings = {},
  events = authorEvents(author.model),
) {
  const host = createFakePluginHost({
    pluginId: "review",
    settings,
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({
            id: "thr_author",
            projectId: "proj_1",
            environmentId: "env_1",
            providerId: author.providerId,
            originPluginId: author.originPluginId,
          }),
        defaultExecutionOptions: async () => ({ model: author.model }) as never,
        events: {
          list: async (args) => {
            const filtered = events
              .filter(
                (event) =>
                  (!args.types || args.types.includes(event.type as never)) &&
                  (!args.afterSeq || event.seq > Number(args.afterSeq)) &&
                  (!args.beforeSeq || event.seq < Number(args.beforeSeq)),
              )
              .sort((a, b) => (args.order === "asc" ? a.seq - b.seq : b.seq - a.seq));
            return filtered.slice(0, Number(args.limit ?? 100)) as never;
          },
        },
        storageLocation: async () => ({ hostId: "host_laptop" }) as never,
        spawn: async () => makeThreadResponse({ id: "thr_review" }) as never,
      },
      files: {
        read: async () => ({ content: "Check the parser.", contentEncoding: "utf8" }) as never,
      },
    },
  });
  await plugin(host.bb);
  const run = (argv: string[]) =>
    host.harness.runCli(argv, {
      threadId: "thr_author",
      cwd: "/work/repo",
      signal: new AbortController().signal,
    });
  return { run, sdk: host.harness.sdk };
}

test("a Claude author gets a hidden max-effort Codex reviewer under its thread", async () => {
  const { run, sdk } = await load({ providerId: "claude-code", model: "claude-opus-5-5[1m]" });

  const result = await run(["start", "--prompt", "Attack the retry loop."]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(
    [
      "Reviewer thr_review started on codex gpt-6-astra.",
      "Wait: bb thread wait thr_review --timeout 90s",
      "Repeat the wait if it times out. The review is still running.",
      "Findings: bb thread output thr_review",
      "",
    ].join("\n"),
  );
  const [spawn] = sdk.callsTo("threads.spawn")[0] as [Record<string, unknown>];
  expect(spawn).toMatchObject({
    projectId: "proj_1",
    environment: { type: "reuse", environmentId: "env_1" },
    parentThreadId: "thr_author",
    visibility: "hidden",
    title: "Adversarial review",
    providerId: "codex",
    model: "gpt-6-astra",
    reasoningLevel: "max",
    serviceTier: "fast",
  });
  expect(spawn["prompt"]).toEndWith("## Brief from the author\n\nAttack the retry loop.");
});

test("reviewer selection uses the author turn, despite a pending model change and steering", async () => {
  const events = [
    ...authorEvents("openai/gpt-5.4"),
    {
      seq: 4,
      type: "client/turn/requested",
      data: { requestId: "req_steer", execution: { model: "anthropic/claude-opus-5-5" } },
    },
    {
      seq: 5,
      type: "turn/input/accepted",
      scope: { kind: "turn", turnId: "turn_author" },
      data: { clientRequestId: "req_steer" },
    },
  ];
  const { run, sdk } = await load(
    { providerId: "pi", model: "anthropic/claude-opus-5-5" },
    {},
    events,
  );

  await run(["start", "--prompt", "Attack the parser."]);

  expect(sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
    providerId: "claude-code",
    model: "claude-opus-5-5[1m]",
  });
});

test("queued requests do not replace the accepted author model, including across history pages", async () => {
  const events = [
    authorEvents("openai/gpt-5.4")[0]!,
    ...Array.from({ length: 101 }, (_, index) => ({
      seq: index + 2,
      type: "client/turn/requested",
      data: { requestId: `req_queued_${index}`, execution: { model: "anthropic/claude-opus-5-5" } },
    })),
    { seq: 103, type: "turn/started", scope: { kind: "turn", turnId: "turn_author" }, data: {} },
    {
      seq: 104,
      type: "turn/input/accepted",
      scope: { kind: "turn", turnId: "turn_author" },
      data: { clientRequestId: "req_author" },
    },
  ];
  const { run, sdk } = await load(
    { providerId: "pi", model: "anthropic/claude-opus-5-5" },
    {},
    events,
  );

  const result = await run(["start", "--prompt", "Attack the parser."]);

  expect(result.exitCode).toBe(0);
  expect(sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
    providerId: "claude-code",
    model: "claude-opus-5-5[1m]",
  });
});

test("a multi-family provider with no recorded author turn reports an error and spawns nothing", async () => {
  const { run, sdk } = await load({ providerId: "pi", model: "openai/gpt-5.4" }, {}, []);

  const result = await run(["start", "--prompt", "Attack the parser."]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("This thread has no recorded author turn");
  expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
});

test("an OpenAI author gets the configured Claude reviewer, whatever its provider", async () => {
  const { run, sdk } = await load(
    { providerId: "agent-proxy", model: "gpt-6-astra" },
    { claudeModel: "claude-fable-5-1" },
  );

  await run(["start", "--prompt", "x"]);

  expect(sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
    providerId: "claude-code",
    model: "claude-fable-5-1",
  });
});

for (const model of [
  "openai/gpt-5.4",
  "openrouter/openai/gpt-5.1-codex",
  "openai/o3",
  "openai:gpt-6-astra",
  "fusion-gpt-6-astra-high-sidekick-swe-2-high",
  "fusion-gpt-6-1-sol-high-sidekick-swe-2-high",
]) {
  test(`an OpenAI author (${model}) gets a Claude reviewer`, async () => {
    const { run, sdk } = await load({
      providerId: model.startsWith("fusion-") ? "devin" : "pi",
      model,
    });

    const result = await run(["start", "--prompt", "Attack the parser."]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith(
      "Reviewer thr_review started on claude-code claude-opus-5-5[1m].",
    );
    expect(sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-5-5[1m]",
    });
  });
}

test("a colon-qualified Claude author gets a Codex reviewer", async () => {
  const { run, sdk } = await load({ providerId: "hermes", model: "anthropic:claude-fable-5" });

  const result = await run(["start", "--prompt", "Attack the parser."]);

  expect(result.exitCode).toBe(0);
  expect(sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
    providerId: "codex",
    model: "gpt-6-astra",
  });
});

test("reviewer threads cannot spawn a nested reviewer", async () => {
  const { run, sdk } = await load({
    providerId: "claude-code",
    model: "claude-opus-5-5[1m]",
    originPluginId: "review",
  });

  const result = await run(["start", "--prompt", "Attack the parser."]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Reviewer threads cannot start another review");
  expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
});

test("--file reads the brief from the calling thread's machine, relative to its cwd", async () => {
  const { run, sdk } = await load({ providerId: "codex", model: "gpt-6-astra" });

  await run(["start", "--file", "brief.md"]);

  expect(sdk.callsTo("files.read")[0]?.[0]).toMatchObject({
    hostId: "host_laptop",
    path: "/work/repo/brief.md",
  });
  const [spawn] = sdk.callsTo("threads.spawn")[0] as [{ prompt: string }];
  expect(spawn.prompt).toEndWith("Check the parser.");
});

test("outside a thread it refuses and spawns nothing", async () => {
  const host = createFakePluginHost({ pluginId: "review" });
  await plugin(host.bb);

  const result = await host.harness.runCli(["start", "--prompt", "x"], {
    signal: new AbortController().signal,
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("bb review start must run inside a bb thread");
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
});
