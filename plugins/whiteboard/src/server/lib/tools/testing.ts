import { readFileSync } from "node:fs";
import type { Engine, ThreadContextInput } from "../../../shared/contracts/engine.ts";
import type { JsonObject } from "../../../shared/vendor/json/src/index.ts";
import { ReviewApiClient } from "../../../shared/vendor/review/src/review-api/client.ts";

/**
 * Test doubles for the agent tool surface. Not imported by runtime code.
 */

export type GoldenTool = { name: string; description: string; inputSchema: JsonObject };
export type Golden = {
  upstream: string;
  guidanceSource: string;
  scratchpadOff: { tools: GoldenTool[] };
  scratchpadOn: { tools: GoldenTool[] };
};

/** The upstream published catalog captured at 4ecc570 (design §4.3). */
export function loadGolden(): Golden {
  return JSON.parse(
    readFileSync(
      new URL("../../../../test/vendor/generated/tool-catalog.golden.json", import.meta.url),
      "utf8",
    ),
  ) as Golden;
}

/** A fake engine: tool calls reach `handle` as the HTTP request the loopback client sends. */
export function fakeEngine(handle: (request: Request) => Response | Promise<Response>) {
  const contexts: ThreadContextInput[] = [];
  const requests: Array<{ method: string; path: string; body: string | null }> = [];
  const engine: Engine = {
    request: async () => {
      throw new Error("fake engine: request is not used by tools");
    },
    info: async () => {
      throw new Error("fake engine: info is not used by tools");
    },
    client: () =>
      new ReviewApiClient(
        { serverUrl: "http://whiteboard.local", token: "" },
        async (url, init) => {
          const request = new Request(url, init);
          const parsed = new URL(request.url);
          requests.push({
            method: request.method,
            path: `${parsed.pathname}${parsed.search}`,
            body: request.method === "GET" ? null : await request.clone().text(),
          });
          return handle(request);
        },
      ),
    withThread: async (context, fn) => {
      contexts.push(context);
      return fn();
    },
    dispose: async () => {},
  };
  return { engine, contexts, requests };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
