import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendOracleTrace,
  completeOracleReport,
  loadOracleReport,
  startOracleReport,
} from "../src/oracle-report-store.ts";

test("Oracle reports persist and load bounded text content", () => {
  const directory = mkdtempSync(join(tmpdir(), "amp-oracle-"));
  try {
    const reportId = startOracleReport({ task: "Review the protocol seam" }, directory);
    assert.ok(reportId);
    assert.equal(loadOracleReport(reportId, directory)?.status, "running");
    assert.equal(appendOracleTrace(reportId, {
      kind: "thinking",
      title: "Thinking",
      content: "Inspecting the protocol seam",
    }, directory), true);
    assert.equal(appendOracleTrace(reportId, {
      kind: "tool",
      toolCallId: "tu-read",
      title: "Read src/a.ts",
      status: "running",
    }, directory), true);
    assert.equal(appendOracleTrace(reportId, {
      kind: "tool",
      toolCallId: "tu-read",
      title: "Read",
      status: "completed",
    }, directory), true);
    assert.equal(completeOracleReport(reportId, [
      { type: "text", text: "## Recommendation" },
      { type: "image", source: { type: "base64", data: "ignored" } },
      { type: "text", text: "Keep the protocol seam. ✓" },
    ], false, directory), true);
    const report = loadOracleReport(reportId, directory);
    assert.equal(report?.id, reportId);
    assert.equal(report?.request, "Review the protocol seam");
    assert.equal(report?.response, "## Recommendation\nKeep the protocol seam. ✓");
    assert.equal(report?.status, "completed");
    assert.deepEqual(report?.trace.map((event) => [event.kind, event.status]), [
      ["thinking", null],
      ["tool", "completed"],
    ]);
    assert.ok(report?.createdAt);
    assert.equal(statSync(join(directory, `${reportId}.json`)).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Oracle reports allow bounded content with heavy JSON escaping", () => {
  const directory = mkdtempSync(join(tmpdir(), "amp-oracle-"));
  try {
    const response = "\n".repeat(300_000);
    const reportId = startOracleReport(null, directory);
    assert.ok(reportId);
    assert.equal(completeOracleReport(reportId, response, false, directory), true);
    assert.equal(loadOracleReport(reportId, directory)?.response, response);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("finishing an interrupted Oracle settles running trace tools", () => {
  const directory = mkdtempSync(join(tmpdir(), "amp-oracle-"));
  try {
    const reportId = startOracleReport({ task: "Review it" }, directory);
    assert.ok(reportId);
    assert.equal(appendOracleTrace(reportId, {
      kind: "tool",
      toolCallId: "tu-running",
      title: "Read src/a.ts",
      status: "running",
    }, directory), true);
    assert.equal(completeOracleReport(
      reportId,
      "Oracle execution was cancelled before returning a result.",
      true,
      directory,
    ), true);
    const report = loadOracleReport(reportId, directory);
    assert.equal(report?.status, "error");
    assert.deepEqual(report?.trace.map((event) => event.status), ["error"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Oracle report reads reject traversal and malformed files", () => {
  const directory = mkdtempSync(join(tmpdir(), "amp-oracle-"));
  try {
    assert.equal(loadOracleReport("../sessions", directory), null);
    const reportId = "11111111-1111-4111-8111-111111111111";
    writeFileSync(join(directory, `${reportId}.json`), '{"response": 42}\n');
    assert.equal(loadOracleReport(reportId, directory), null);

    const legacyId = "22222222-2222-4222-8222-222222222222";
    writeFileSync(join(directory, `${legacyId}.json`), JSON.stringify({
      id: legacyId,
      response: "Earlier Oracle response",
      status: "completed",
      createdAt: "2026-08-08T00:00:00.000Z",
    }));
    const legacy = loadOracleReport(legacyId, directory);
    assert.equal(legacy?.request, null);
    assert.deepEqual(legacy?.trace, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
