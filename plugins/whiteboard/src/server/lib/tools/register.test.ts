import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, test } from "vitest";
import type { Engine } from "../../../shared/contracts/engine.ts";
import { createSettings } from "../settings.ts";
import { registerTools, whiteboardCatalog } from "./register.ts";
import { fakeEngine, json } from "./testing.ts";

async function host(engine: Engine) {
  const fake = createFakePluginHost({ pluginId: "whiteboard" });
  await registerTools(fake.bb, engine, createSettings(fake.bb));
  return fake.harness;
}

const text = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });

describe("no thrown error escapes execute", () => {
  const working = fakeEngine(() => json({ ok: true })).engine;
  const engines: Array<[string, Engine, string, boolean]> = [
    [
      "client() throws",
      {
        ...working,
        client: () => {
          throw new Error("client gone");
        },
      },
      "client gone",
      true,
    ],
    [
      "withThread throws synchronously",
      {
        ...working,
        withThread: () => {
          throw new Error("sync");
        },
      },
      "sync",
      true,
    ],
    [
      "withThread rejects",
      {
        ...working,
        withThread: async () => {
          throw new Error("async");
        },
      },
      "async",
      true,
    ],
    [
      "withThread rejects with a string",
      { ...working, withThread: () => Promise.reject("plain") },
      "plain",
      true,
    ],
    [
      "withThread rejects with undefined",
      { ...working, withThread: () => Promise.reject(undefined) },
      "undefined",
      true,
    ],
    [
      "withThread rejects with null",
      { ...working, withThread: () => Promise.reject(null) },
      "null",
      true,
    ],
    [
      "withThread rejects with an object whose toString throws",
      {
        ...working,
        withThread: () =>
          Promise.reject({
            toString() {
              throw new Error("nope");
            },
          }),
      },
      "[object Object]",
      true,
    ],
    [
      "fetch throws",
      fakeEngine(() => {
        throw new TypeError("fetch failed");
      }).engine,
      "fetch failed",
      false,
    ],
    [
      "the route answers 500 without a body",
      fakeEngine(() => new Response("", { status: 500 })).engine,
      "Review request failed (500).",
      false,
    ],
    [
      "the route answers an error body",
      fakeEngine(() => json({ error: "Invalid input: title is required." }, 400)).engine,
      "Invalid input: title is required.",
      false,
    ],
  ];
  const inputs: unknown[] = [{ sessionId: "s1", commandId: "c1" }, {}, null, "text", [1, 2], 42];

  test.each(engines)(
    "%s: every tool and input answers isError with the bare message",
    async (_label, engine, message, engineLevel) => {
      const harness = await host(engine);
      const texts = new Set<string>();
      for (const { name } of whiteboardCatalog(false))
        for (const input of inputs) {
          const result = await harness.callAgentTool(name, input);
          expect(result).toMatchObject({ isError: true, content: [{ type: "text" }] });
          texts.add((result as unknown as { content: [{ text: string }] }).content[0].text);
        }
      // A failing engine fails every call. When the failure is in the route,
      // calls with no sessionId stop first at upstream's own check.
      expect([...texts].sort()).toEqual(
        engineLevel ? [message] : [message, "reviewId is required."].sort(),
      );
    },
  );
});

describe("results and errors are upstream's text", () => {
  test("a file's text echoed by the engine comes back byte for byte", async () => {
    const file = {
      path: "src/a.ts",
      text: 'call session_get( then session_edit, review_open; reviewId: "r"\n  é\u{1F600}\t"quoted" \\ end\n',
    };
    const body = JSON.stringify(file);
    const { engine, requests } = fakeEngine(() => json(file));
    const harness = await host(engine);
    const result = await harness.callAgentTool("whiteboard_session_file", {
      sessionId: "s 1",
      path: "src/a.ts",
    });
    expect(result).toEqual({ content: [{ type: "text", text: body }] });
    expect(requests).toEqual([
      { method: "GET", path: "/reviews-api/s%201/file?path=src%2Fa.ts", body: null },
    ]);
  });

  test("a plain-text reply is returned as is", async () => {
    const outline = "# Title\nsession_get reviewId review_edit\n";
    const { engine } = fakeEngine(() => text(outline));
    const harness = await host(engine);
    expect(await harness.callAgentTool("whiteboard_session_get", { sessionId: "s1" })).toEqual({
      content: [{ type: "text", text: outline }],
    });
  });

  test("envelope keys are renamed as upstream's publicResult does, nothing else", async () => {
    const { engine } = fakeEngine(() =>
      json({ reviewId: "r1", review: { reviewId: "r1", title: "review_x" }, note: "reviewId" }),
    );
    const harness = await host(engine);
    expect(
      await harness.callAgentTool("whiteboard_session_rename", {
        sessionId: "r1",
        commandId: "c",
        title: "T",
      }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: '{"sessionId":"r1","session":{"sessionId":"r1","title":"review_x"},"note":"reviewId"}',
        },
      ],
    });
  });

  test("reviewId is refused with upstream's message", async () => {
    const { engine, requests } = fakeEngine(() => json({}));
    const harness = await host(engine);
    expect(await harness.callAgentTool("whiteboard_session_get", { reviewId: "r1" })).toEqual({
      isError: true,
      content: [{ type: "text", text: "Use sessionId with session tools." }],
    });
    expect(requests).toEqual([]);
  });

  test("a missing sessionId fails with upstream's message", async () => {
    const { engine } = fakeEngine(() => json({}));
    const harness = await host(engine);
    expect(await harness.callAgentTool("whiteboard_session_get", {})).toEqual({
      isError: true,
      content: [{ type: "text", text: "reviewId is required." }],
    });
  });

  test("non-object input is called as {}", async () => {
    const { engine, requests } = fakeEngine(() => json([]));
    const harness = await host(engine);
    expect(await harness.callAgentTool("whiteboard_session_list", "nonsense")).toEqual({
      content: [{ type: "text", text: "[]" }],
    });
    expect(requests).toEqual([{ method: "GET", path: "/reviews-api", body: null }]);
  });
});

test("calls run in the calling thread's context", async () => {
  const { engine, contexts } = fakeEngine(() => json([]));
  const harness = await host(engine);
  const signal = new AbortController().signal;
  await harness.callAgentTool(
    "whiteboard_session_list",
    {},
    { threadId: "t1", projectId: "p1", signal },
  );
  expect(contexts).toEqual([{ threadId: "t1", projectId: "p1", signal }]);
});

test("a tool bb refuses is logged and the rest still register", async () => {
  const fake = createFakePluginHost({ pluginId: "whiteboard" });
  fake.bb.agents.registerTool({
    name: "whiteboard_status",
    description: "taken",
    parameters: { type: "object" },
    execute: () => "",
  });
  await registerTools(fake.bb, fakeEngine(() => json({})).engine, createSettings(fake.bb));
  const names = fake.harness.registrations.agentTools.map((tool) => tool.name);
  expect(names).toHaveLength(28);
  expect(names.filter((name) => name === "whiteboard_status")).toHaveLength(1);
  expect(fake.harness.logEntries.filter((entry) => entry.level === "error")).toEqual([
    {
      level: "error",
      message:
        'whiteboard: whiteboard_status was not registered: tool "whiteboard_status" is already registered',
    },
  ]);
});
