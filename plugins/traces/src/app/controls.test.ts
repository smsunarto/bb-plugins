import assert from "node:assert/strict";
import { test } from "node:test";
import type { TraceEvidence } from "../shared/model.ts";
import {
  distinctEvidence,
  elapsedTime,
  evidenceLabel,
  evidenceTag,
  groupEvidence,
  mcpEntry,
  mcpServer,
  parseStoredSize,
} from "./controls.tsx";

function evidence(label: string, pointer: string): TraceEvidence {
  return { topic: "skills", action: "requested", label, basis: "recorded", pointer };
}

test("elapsed time counts from the session start", () => {
  const start = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(elapsedTime(start, start), "+0:00");
  assert.equal(elapsedTime(start + 7_000, start), "+0:07");
  assert.equal(elapsedTime(start + 95_000, start), "+1:35");
  assert.equal(elapsedTime(start + 3_725_000, start), "+1:02:05");
});

test("elapsed time falls back to the wall clock without a session start", () => {
  const at = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(
    elapsedTime(at, null),
    new Date(at).toLocaleTimeString(undefined, { hour12: false }),
  );
  assert.equal(elapsedTime(null, at), "");
});

test("a trace event before its recorded session start keeps the wall clock", () => {
  const start = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(
    elapsedTime(start - 1_000, start),
    new Date(start - 1_000).toLocaleTimeString(undefined, { hour12: false }),
  );
});

test("evidence labels keep topic, action, and label distinct", () => {
  assert.equal(
    evidenceLabel({
      topic: "sandbox",
      action: "bypass_requested",
      label: "but status",
      basis: "recorded",
      pointer: "/a",
    }),
    "sandbox · bypass requested · but status",
  );
});

test("evidence with the same label collapses across source pointers", () => {
  const items = [evidence("agent-browser", "/a"), evidence("agent-browser", "/b")];
  assert.deepEqual(
    distinctEvidence(items).map((item) => item.label),
    ["agent-browser"],
  );
});

test("evidence with different labels stays separate", () => {
  const items = [evidence("agent-browser", "/a"), evidence("gitbutler", "/b")];
  assert.deepEqual(
    distinctEvidence(items).map((item) => item.label),
    ["agent-browser", "gitbutler"],
  );
});

test("timeline chips drop the topic and keep the action and label", () => {
  assert.equal(
    evidenceTag({
      topic: "sandbox",
      action: "bypass_requested",
      label: "but status",
      basis: "recorded",
      pointer: "/a",
    }),
    "bypass requested · but status",
  );
});

test("a pinned pane width of zero survives a reload", () => {
  assert.equal(parseStoredSize("0"), 0);
  assert.equal(parseStoredSize("260"), 260);
});

test("a missing or unusable pane width falls back to the container", () => {
  assert.equal(parseStoredSize(null), null);
  assert.equal(parseStoredSize(undefined), null);
  assert.equal(parseStoredSize(""), null);
  assert.equal(parseStoredSize("wide"), null);
});

test("MCP evidence collapses tool names and server states onto one server group", () => {
  const groups = groupEvidence([
    {
      topic: "mcp",
      action: "available",
      label: "mcp__cubic__get_issue",
      basis: "recorded",
      pointer: "/a",
    },
    {
      topic: "mcp",
      action: "available",
      label: "mcp__cubic__list_scans",
      basis: "recorded",
      pointer: "/b",
    },
    { topic: "mcp", action: "blocked", label: "cubic (failed)", basis: "recorded", pointer: "/c" },
    {
      topic: "mcp",
      action: "requested",
      label: "cloudflare (pending)",
      basis: "recorded",
      pointer: "/d",
    },
    {
      topic: "skills",
      action: "invoked",
      label: "agent-browser",
      basis: "recorded",
      pointer: "/e",
    },
  ]);
  assert.deepEqual(
    groups.map((group) => [group.name, group.state, group.items.length]),
    [
      ["cubic", "unavailable", 3],
      ["cloudflare", "pending", 1],
      ["Skills", null, 1],
    ],
  );
});

test("an MCP chip drops the server prefix it is already grouped under", () => {
  assert.equal(mcpServer("mcp__bb-bridge__agentation_resolve"), "bb-bridge");
  assert.equal(mcpEntry("mcp__bb-bridge__agentation_resolve"), "agentation_resolve");
  assert.equal(mcpServer("cubic (failed)"), "cubic");
  assert.equal(mcpEntry("cubic (failed)"), "failed");
  assert.equal(mcpEntry("cubic"), "Server");
});
