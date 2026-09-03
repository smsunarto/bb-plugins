import { afterEach, expect, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";

import plugin from "../server.ts";
import type { ThreadEventRow } from "../turn-trace.ts";

const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test("check prints the Langfuse observation tree for the latest turn", async () => {
  let requested: { authorization: string | null; search: string; pathname: string } | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requested = {
        authorization: request.headers.get("authorization"),
        pathname: url.pathname,
        search: url.search,
      };
      return Response.json({
        data: [
          {
            id: "obs-root",
            name: "bb.agent.turn",
            parentObservationId: null,
            startTime: "2026-01-01T00:00:00.000Z",
            endTime: "2026-01-01T00:00:04.000Z",
            type: "AGENT",
            input: [{ role: "user", content: "hello" }],
            output: [{ role: "assistant", content: "done" }],
          },
          {
            id: "obs-gen",
            name: "bb.agent.llm",
            parentObservationId: "obs-root",
            model: "claude-opus-5",
            startTime: "2026-01-01T00:00:00.000Z",
            endTime: "2026-01-01T00:00:03.000Z",
            type: "GENERATION",
            usageDetails: { input: 10, output: 5, total: 15 },
          },
        ],
      });
    },
  });
  servers.push(server);

  const events = [
    {
      id: "event-1",
      threadId: "thread-1",
      seq: 1,
      createdAt: 1,
      type: "turn/started",
      scope: { kind: "turn", turnId: "turn-9" },
      data: { providerThreadId: "provider-thread-1" },
    },
    {
      id: "event-2",
      threadId: "thread-1",
      seq: 2,
      createdAt: 2,
      type: "turn/completed",
      scope: { kind: "turn", turnId: "turn-9" },
      data: { providerThreadId: "provider-thread-1", status: "completed" },
    },
  ] as ThreadEventRow[];
  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-trace",
    settings: {
      laminarEndpoint: "https://api.lmnr.ai/v1/traces",
      langfuseBaseUrl: server.url.toString(),
      langfusePublicKey: "pk-lf-1",
      langfuseSecretKey: "sk-lf-1",
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

  const result = await harness.runCli(["check", "--thread", "thread-1"]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/trace\/[0-9a-f]{32}$/);
  expect(lines[1]).toContain("agent bb.agent.turn");
  expect(lines[1]).toContain(
    '[{"role":"user","content":"hello"}] -> [{"role":"assistant","content":"done"}]',
  );
  expect(lines[2]).toContain("  generation bb.agent.llm model=claude-opus-5 usage={");
  expect(requested?.pathname).toBe("/api/public/v2/observations");
  expect(requested?.search).toContain(`traceId=${lines[0]!.split("/trace/")[1]}`);
  expect(requested?.authorization).toBe(
    `Basic ${Buffer.from("pk-lf-1:sk-lf-1").toString("base64")}`,
  );
  await harness.dispose();
});
