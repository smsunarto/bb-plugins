import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import type { ToolContext } from "nanocodex/host";
import { createParallelWebTool, type ParallelSearch } from "./parallel-web.ts";

const CONTEXT = {
  callId: "call-1",
  parentCallId: "parent-1",
  sessionId: "session-1",
  signal: new AbortController().signal,
} satisfies ToolContext;

test("web__run translates filtered searches into bounded Parallel SDK calls", async () => {
  const search = mock(
    async (request: Parameters<ParallelSearch>[0], _options: Parameters<ParallelSearch>[1]) => {
      const query = request.search_queries[0] ?? "";
      return {
        search_id: `search-${query}`,
        session_id: request.session_id ?? "generated-session",
        results: [{ title: query, url: "https://example.test", excerpts: ["evidence"] }],
      };
    },
  );
  const tool = createParallelWebTool({
    search: search satisfies ParallelSearch,
    now: () => new Date("2026-08-31T12:00:00Z"),
  });

  const output = await tool.handler(
    {
      search_query: [
        { q: "latest Bun release", domains: ["bun.sh"], recency: 7 },
        { q: "Parallel CLI documentation" },
      ],
      response_length: "short",
    },
    CONTEXT,
  );

  assert.deepEqual(
    search.mock.calls.map(([request]) => request),
    [
      {
        search_queries: ["latest Bun release"],
        mode: "fast",
        max_chars_total: 12_000,
        session_id: "session-1",
        advanced_settings: {
          max_results: 5,
          source_policy: {
            include_domains: ["bun.sh"],
            after_date: "2026-08-24",
          },
        },
      },
      {
        search_queries: ["Parallel CLI documentation"],
        mode: "fast",
        max_chars_total: 12_000,
        session_id: "session-1",
        advanced_settings: { max_results: 5 },
      },
    ],
  );
  for (const [, options] of search.mock.calls) {
    assert.equal(options.timeout, 30_000);
    assert.equal(options.maxRetries, 0);
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(typeof output, "string");
  if (typeof output !== "string") throw new Error("expected string output");
  const parsed: unknown = JSON.parse(output);
  assert.deepEqual(parsed, {
    search_query: [
      {
        q: "latest Bun release",
        result: {
          search_id: "search-latest Bun release",
          session_id: "session-1",
          results: [
            { title: "latest Bun release", url: "https://example.test", excerpts: ["evidence"] },
          ],
        },
      },
      {
        q: "Parallel CLI documentation",
        result: {
          search_id: "search-Parallel CLI documentation",
          session_id: "session-1",
          results: [
            {
              title: "Parallel CLI documentation",
              url: "https://example.test",
              excerpts: ["evidence"],
            },
          ],
        },
      },
    ],
  });
});

test("web__run rejects invalid input before invoking Parallel", async () => {
  const search = mock(async () => ({
    search_id: "unused",
    session_id: "unused",
    results: [],
  }));
  const tool = createParallelWebTool({ search: search satisfies ParallelSearch });

  await assert.rejects(
    async () => tool.handler({ search_query: [] }, CONTEXT),
    /Too small|at least 1|minimum/i,
  );
  assert.equal(search.mock.calls.length, 0);
});

test("web__run reports the failed query without leaking unbounded SDK output", async () => {
  const search = mock(async () => {
    throw new Error("x".repeat(8_000));
  });
  const tool = createParallelWebTool({ search: search satisfies ParallelSearch });

  await assert.rejects(
    async () => tool.handler({ search_query: [{ q: "broken query" }] }, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Parallel web search failed for "broken query"/);
      assert.ok(error.message.length < 4_100);
      return true;
    },
  );
});
