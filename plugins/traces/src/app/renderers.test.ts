import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toolCall, toolResult } from "../shared/providers/tools.ts";
import type { ParsedEvent, TraceEvent } from "../shared/model.ts";
import { defaultTraceRenderers } from "./renderers.tsx";

function render(parsed: ParsedEvent) {
  const event: TraceEvent = {
    ...parsed,
    id: "event",
    sessionId: "session",
    provider: "codex",
    sequence: 0,
    part: 0,
    provenance: {
      path: "/fixture.jsonl",
      line: 1,
      pointer: parsed.pointer,
      byteOffset: 0,
      byteLength: 10,
      recordHash: "fixture",
      adapterVersion: 2,
    },
  };
  return renderToStaticMarkup(
    createElement(defaultTraceRenderers.resolve(event.template), {
      event,
      body: parsed.body,
      related: [],
    }),
  );
}

test("string tool arguments are never presented as a recorded result", () => {
  for (const [name, value] of [
    ["exec_command", '{"cmd":"echo sample"}'],
    ["apply_patch", "*** Begin Patch\n+sample\n*** End Patch"],
  ]) {
    const html = render(
      toolCall(
        {},
        {
          name: name!,
          value,
          callId: "call",
          at: "/payload",
          inputAt: "/payload/arguments",
          nameAt: "/payload/name",
        },
      ),
    );
    assert.match(html, /sample/);
    assert.doesNotMatch(html, /<h3>Result<\/h3>/);
  }
});

test("a recorded tool result remains visible", () => {
  const html = render(
    toolResult(
      {},
      { value: "sample output", callId: "call", at: "/payload", outputAt: "/payload/output" },
    ),
  );
  assert.match(html, /<h3>Result<\/h3>/);
  assert.match(html, /sample output/);
});
