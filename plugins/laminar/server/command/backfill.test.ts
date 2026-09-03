import { afterEach, expect, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";

import plugin from "../server.ts";
import type { ExportTraceServiceRequest, ThreadEventRow } from "../laminar.ts";

const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test("backfills only Laminar's trace-level input/output span", async () => {
  let exported: ExportTraceServiceRequest | undefined;
  let exportCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      exportCount += 1;
      exported = (await request.json()) as ExportTraceServiceRequest;
      return Response.json({ ok: true });
    },
  });
  servers.push(server);

  const events = [
    {
      id: "event-1",
      threadId: "thread-1",
      seq: 1,
      createdAt: 1,
      type: "client/turn/requested",
      scope: { kind: "turn", turnId: "turn-1" },
      data: {
        direction: "outbound",
        execution: {
          model: "model-1",
          permissionMode: "workspace-write",
          reasoningLevel: "medium",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        initiator: "user",
        input: [{ type: "text", text: "visible prompt", mentions: [] }],
        request: { method: "turn/start", params: {} },
        requestId: "request-1",
        senderThreadId: null,
        source: "tell",
        target: { kind: "new-turn" },
      },
    },
    {
      id: "event-2",
      threadId: "thread-1",
      seq: 2,
      createdAt: 2,
      type: "item/completed",
      scope: { kind: "turn", turnId: "turn-1" },
      data: {
        providerThreadId: "provider-thread-1",
        item: { id: "message-1", type: "agentMessage", text: "assistant answer" },
      },
    },
    {
      id: "event-3",
      threadId: "thread-1",
      seq: 3,
      createdAt: 3,
      type: "turn/completed",
      scope: { kind: "turn", turnId: "turn-1" },
      data: { providerThreadId: "provider-thread-1", status: "completed" },
    },
  ] as ThreadEventRow[];
  const { bb, harness } = createFakePluginHost({
    pluginId: "laminar",
    settings: {
      apiKey: "test-key",
      endpoint: new URL("/v1/traces", server.url).toString(),
      deploymentEnvironment: "test",
      contentMode: "full",
    },
    sdk: {
      threads: {
        get: () =>
          makeThreadResponse({
            id: "thread-1",
            projectId: "project-1",
            providerId: "provider-1",
            visibility: "visible",
          }),
        events: { list: () => events },
      },
    },
  });
  await plugin(bb);

  const result = await harness.runCli(["backfill", "--thread", "thread-1"]);

  expect(result).toEqual({
    exitCode: 0,
    stdout: "Backfilled Laminar input/output for 1 completed turn in thread-1.\n",
    stderr: "",
  });
  const spans = exported?.resourceSpans[0]?.scopeSpans[0]?.spans;
  expect(spans).toHaveLength(2);
  expect(spans?.[0]?.name).toBe("bb.trace.output.backfill");
  expect(spans?.[0]?.attributes).toEqual(
    expect.arrayContaining([
      { key: "lmnr.span.type", value: { stringValue: "LLM" } },
      { key: "bb.backfill.content_carrier", value: { boolValue: true } },
      {
        key: "lmnr.span.output",
        value: {
          stringValue: '[{"role":"assistant","content":"assistant answer"}]',
        },
      },
    ]),
  );
  expect(spans?.[1]?.attributes).toEqual(
    expect.arrayContaining([
      { key: "lmnr.internal.metadata_only", value: { boolValue: true } },
      { key: "lmnr.internal.trace_input", value: { stringValue: "visible prompt" } },
      {
        key: "lmnr.internal.trace_output_hashes",
        value: {
          arrayValue: {
            values: [
              {
                stringValue: "62de9a778101786ad11155c8c3fb646ef17ec1aaadd5b1d72e2dfdd624f1485d",
              },
            ],
          },
        },
      },
    ]),
  );

  expect(await harness.runCli(["backfill", "--thread", "thread-1"])).toEqual({
    exitCode: 0,
    stdout: "Backfilled Laminar input/output for 0 completed turns in thread-1.\n",
    stderr: "",
  });
  expect(exportCount).toBe(1);
  await harness.dispose();
});
