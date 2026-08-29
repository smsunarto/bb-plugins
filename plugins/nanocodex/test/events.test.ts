import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NANOCODEX_EVENT_KINDS,
  NANOCODEX_EVENT_VISIBILITY,
  assistantTextSchema,
  eventUsageSchema,
  isTerminalKind,
  modelCallCompletedSchema,
  nanocodexVisibility,
  parseEventLine,
  runTerminalSchema,
  toolCallSchema,
  toolResultSchema,
} from "../src/bridge/events.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixtureLines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

const KNOWN_KINDS = new Set<string>(NANOCODEX_EVENT_KINDS);

for (const fixture of ["hello.jsonl", "tool-run.jsonl"]) {
  test(`every line of ${fixture} parses as an envelope with a classified kind`, () => {
    const lines = fixtureLines(fixture);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      const envelope = parseEventLine(line);
      assert.notEqual(envelope, null, line.slice(0, 120));
      assert.ok(KNOWN_KINDS.has(envelope!.type), `unclassified kind: ${envelope!.type}`);
      assert.equal(envelope!.protocol_version, 1);
    }
  });

  test(`${fixture} ends with exactly one terminal event`, () => {
    const kinds = fixtureLines(fixture).map((line) => parseEventLine(line)!.type);
    assert.equal(kinds.filter((kind) => isTerminalKind(kind)).length, 1);
    assert.ok(isTerminalKind(kinds.at(-1)!));
  });
}

test("api.event dominates the byte count and is classified as noise", () => {
  const lines = fixtureLines("tool-run.jsonl");
  const noiseBytes = lines
    .filter((line) => parseEventLine(line)!.type === "api.event")
    .reduce((total, line) => total + line.length, 0);
  const totalBytes = lines.reduce((total, line) => total + line.length, 0);
  assert.ok(noiseBytes / totalBytes > 0.9, `${noiseBytes}/${totalBytes}`);
  assert.equal(NANOCODEX_EVENT_VISIBILITY["api.event"], "noise");
});

test("only run.completed and run.failed are terminal; run.error is not", () => {
  assert.ok(isTerminalKind("run.completed"));
  assert.ok(isTerminalKind("run.failed"));
  assert.ok(!isTerminalKind("run.error"));
  assert.ok(!isTerminalKind("run.steered"));
});

test("parseEventLine never throws and rejects non-envelopes", () => {
  assert.equal(parseEventLine(""), null);
  assert.equal(parseEventLine("thread 'main' panicked at src/lib.rs"), null);
  assert.equal(parseEventLine("{not json"), null);
  assert.equal(parseEventLine('{"protocol_version":1}'), null);
  assert.equal(parseEventLine("[1,2,3]"), null);
});

test("the run terminal carries flat usage plus a separate warmup_usage", () => {
  const lines = fixtureLines("hello.jsonl");
  const terminal = parseEventLine(lines.at(-1)!)!;
  const payload = runTerminalSchema.parse(terminal.payload);
  assert.equal(payload.status, "completed");
  const usage = eventUsageSchema.parse(payload.usage);
  assert.ok(usage.input_tokens > 10_000);
  assert.ok(usage.total_tokens >= usage.input_tokens + usage.output_tokens);
  const warmup = eventUsageSchema.parse(payload.warmup_usage);
  assert.ok(warmup.input_tokens > 0);
});

test("the first model.call.completed carries the nested per-call usage shape", () => {
  const calls = fixtureLines("hello.jsonl")
    .map((line) => parseEventLine(line)!)
    .filter((envelope) => envelope.type === "model.call.completed")
    .map((envelope) => modelCallCompletedSchema.parse(envelope.payload));
  const first = calls.find((call) => call.call_index === 1);
  assert.notEqual(first, undefined);
  assert.ok((first!.usage?.input_tokens ?? 0) > 10_000);
});

test("code mode: a string-arguments exec parent with call_id-suffixed children", () => {
  const toolEvents = fixtureLines("tool-run.jsonl")
    .map((line) => parseEventLine(line)!)
    .filter((envelope) => envelope.type === "tool.call")
    .map((envelope) => toolCallSchema.parse(envelope.payload));
  const parent = toolEvents.find((call) => call.tool === "exec");
  assert.notEqual(parent, undefined);
  assert.equal(typeof parent!.arguments, "string");
  const children = toolEvents.filter((call) => call.call_id.startsWith(`${parent!.call_id}/code-`));
  assert.ok(children.length >= 2);
  for (const child of children) assert.match(child.call_id, /\/code-\d+$/);
});

test("tool results parse both body shapes: string and content blocks", () => {
  const results = fixtureLines("tool-run.jsonl")
    .map((line) => parseEventLine(line)!)
    .filter((envelope) => envelope.type === "tool.result")
    .map((envelope) => toolResultSchema.parse(envelope.payload));
  assert.ok(results.some((result) => typeof result.result === "string"));
  assert.ok(results.some((result) => Array.isArray(result.result)));
  for (const result of results) assert.equal(result.status, "completed");
});

test("assistant messages carry both phases", () => {
  const phases = fixtureLines("tool-run.jsonl")
    .map((line) => parseEventLine(line)!)
    .filter((envelope) => envelope.type === "assistant.message")
    .map((envelope) => assistantTextSchema.parse(envelope.payload).phase);
  assert.ok(phases.includes("commentary"));
  assert.ok(phases.includes("final_answer"));
});

test("the visibility metadata mirrors the classification record", () => {
  const noise = nanocodexVisibility.describeRawEvent({
    jsonrpc: "2.0",
    method: "nanocodex/noise",
    params: { type: "api.event" },
  } as never);
  assert.deepEqual(noise, { kind: "api.event", coverage: "noise" });
  const normalized = nanocodexVisibility.describeParsedRawEvent({ kind: "tool.call" });
  assert.equal(normalized.coverage, "normalized");
  const unknown = nanocodexVisibility.describeParsedRawEvent({ kind: "future.kind" });
  assert.equal(unknown.coverage, "unknown");
});
