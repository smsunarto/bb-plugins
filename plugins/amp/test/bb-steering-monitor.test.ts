import assert from "node:assert/strict";
import test from "node:test";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { createBbSteeringMonitor } from "../src/bb-steering-monitor.ts";

interface TestEvent {
  seq: number;
  scope: { kind: "thread" } | { kind: "turn"; turnId: string };
  type: string;
  data: Record<string, unknown>;
}

const request = (
  seq: number,
  requestId: string,
  target: Record<string, unknown>,
  input: unknown[],
  inputGroups?: unknown[][],
): TestEvent => ({
  seq,
  scope: { kind: "thread" },
  type: "client/turn/requested",
  data: {
    requestId,
    target,
    input,
    ...(inputGroups === undefined ? {} : { inputGroups }),
  },
});

const accepted = (seq: number, requestId: string, turnId: string): TestEvent => ({
  seq,
  scope: { kind: "turn", turnId },
  type: "turn/input/accepted",
  data: { clientRequestId: requestId },
});

function responseJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

test("watches only newly accepted steering for the active turn", async () => {
  const oldEvents: TestEvent[] = [
    request(1, "start", { kind: "thread-start" }, []),
    request(4, "old", { kind: "steer", expectedTurnId: "turn-old" }, [
      { type: "text", text: "old steer" },
    ]),
    accepted(5, "old", "turn-old"),
  ];
  const liveEvents: TestEvent[] = [
    request(6, "new-turn", { kind: "new-turn" }, [{ type: "text", text: "not steering" }]),
    accepted(7, "new-turn", "turn-active"),
    request(8, "wrong-turn", { kind: "steer", expectedTurnId: "turn-other" }, [
      { type: "text", text: "wrong turn" },
    ]),
    accepted(9, "wrong-turn", "turn-active"),
    request(10, "missing-turn", { kind: "steer", expectedTurnId: null }, [
      { type: "text", text: "missing turn" },
    ]),
    accepted(11, "missing-turn", "turn-active"),
    request(
      12,
      "accepted-steer",
      { kind: "auto", expectedTurnId: "turn-active" },
      [],
      [
        [
          { type: "text", text: "use this" },
          { type: "image", url: "https://example.test/a.png" },
        ],
        [
          { type: "localImage", path: "/tmp/b.png" },
          { type: "localFile", path: "/tmp/context.txt" },
        ],
      ],
    ),
    accepted(13, "accepted-steer", "turn-active"),
  ];
  let exposeLiveEvents = false;
  const requestedUrls: URL[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    requestedUrls.push(url);
    const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
    const events = exposeLiveEvents ? [...oldEvents, ...liveEvents] : oldEvents;
    if (url.pathname.endsWith("/wait")) {
      const type = url.searchParams.get("type");
      return responseJson(
        events.find((event) => event.seq > afterSeq && event.type === type) ?? null,
      );
    }
    const limit = Number(url.searchParams.get("limit") ?? "1000");
    return responseJson(events.filter((event) => event.seq > afterSeq).slice(0, limit));
  };

  const monitor = await createBbSteeringMonitor({
    serverUrl: "http://127.0.0.1:38886",
    threadId: "thread/id",
    fetch: fetchFn,
  });
  assert.ok(monitor);
  exposeLiveEvents = true;

  const controller = new AbortController();
  const received: ContentBlock[][] = [];
  await monitor.run((input) => {
    received.push(input);
    controller.abort();
  }, controller.signal);

  assert.deepEqual(received, [
    [
      { type: "text", text: "use this" },
      { type: "text", text: "[image attachment: https://example.test/a.png]" },
      { type: "text", text: "\n\n" },
      { type: "text", text: "[image attachment on disk: /tmp/b.png]" },
      {
        type: "resource_link",
        uri: "file:///tmp/context.txt",
        name: "context.txt",
      },
    ],
  ]);
  assert.equal(requestedUrls[0]?.searchParams.get("afterSeq"), "0");
  assert.ok(
    requestedUrls.some(
      (url) => url.pathname.endsWith("/wait") && url.searchParams.get("afterSeq") === "5",
    ),
    "the monitor must start after the creation-time cursor",
  );
});

test("does not start without bb thread context", async () => {
  assert.equal(
    await createBbSteeringMonitor({
      serverUrl: "",
      threadId: "",
      fetch: async () => responseJson([]),
    }),
    null,
  );
});
