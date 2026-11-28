import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcpToolCallUpdateEvent } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { classifyAntigravityToolCall, readAntigravityToolIdentity } from "./dialect.ts";

function toolEvent(overrides: Partial<AcpToolCallUpdateEvent>): AcpToolCallUpdateEvent {
  return {
    sessionUpdate: "tool_call",
    toolCallId: "tc_1",
    ...overrides,
  };
}

test("classifies invoke_subagent as a background delegation item", () => {
  const classified = classifyAntigravityToolCall(
    toolEvent({
      name: "invoke_subagent",
      rawInput: {
        TypeName: "research",
        Role: "Codebase Researcher",
        Prompt: "Survey all provider plugins",
      },
    }),
  );

  assert.ok(classified);
  assert.deepEqual(classified.item, {
    type: "delegation",
    childRef: "tc_1",
    label: "Codebase Researcher",
    background: true,
  });
  assert.equal(classified.presentation.icon.glyph, "Bot");
  assert.equal(classified.presentation.title, "Codebase Researcher");
  assert.equal(classified.presentation.detail, "research");
});

test("classifies update_steps as planSteps", () => {
  const classified = classifyAntigravityToolCall(
    toolEvent({
      name: "update_steps",
      rawInput: {
        steps: [
          { title: "Scaffold plugin", status: "done" },
          { title: "Implement bridge", status: "in_progress" },
          { title: "Run tests", status: "pending" },
        ],
      },
    }),
  );

  assert.ok(classified);
  assert.deepEqual(classified.item, {
    type: "planSteps",
    steps: [
      { step: "Scaffold plugin", status: "completed" },
      { step: "Implement bridge", status: "active" },
      { step: "Run tests", status: "pending" },
    ],
  });
});

test("classifies search_web as webSearch", () => {
  const classified = classifyAntigravityToolCall(
    toolEvent({
      name: "search_web",
      rawInput: { query: "agent client protocol spec" },
    }),
  );

  assert.ok(classified);
  assert.deepEqual(classified.item, {
    type: "webSearch",
    queries: ["agent client protocol spec"],
  });
});

test("reads tool identity from _meta fallback", () => {
  const identity = readAntigravityToolIdentity(
    toolEvent({ _meta: { toolName: "invoke_subagent" } } as Partial<AcpToolCallUpdateEvent>),
  );
  assert.deepEqual(identity, { name: "invoke_subagent" });
});
