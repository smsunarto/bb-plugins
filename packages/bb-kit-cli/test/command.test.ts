import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/index.js";

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
  };
}

describe("bb-kit command interface", () => {
  it("prints usage for help and for a missing command", async () => {
    const help = capture();
    expect(await runCli(["help"], { io: help.io })).toBe(0);
    expect(help.stdout[0]).toContain("bb-kit compatibility inspect [--json]");

    const missing = capture();
    expect(await runCli([], { io: missing.io })).toBe(2);
    expect(missing.stdout[0]).toContain("bb-kit check --workspace [--json]");
  });

  it("prints command-local help without touching the workspace", async () => {
    const output = capture();
    expect(await runCli(["compatibility", "upgrade", "--help"], { io: output.io })).toBe(0);
    expect(output.stdout).toEqual(["Usage: bb-kit compatibility upgrade [--json]"]);
    expect(output.stderr).toEqual([]);
  });

  it("emits stable JSON for usage errors", async () => {
    const output = capture();
    expect(await runCli(["compatibility", "check", "--wat", "--json"], { io: output.io })).toBe(2);
    expect(JSON.parse(output.stdout[0] ?? "null")).toEqual({
      ok: false,
      error: { code: "usage", message: "unknown option --wat" },
    });
  });

  it("rejects removed commands and the project-level check", async () => {
    const removed = capture();
    expect(await runCli(["operations", "--json"], { io: removed.io })).toBe(2);
    expect(JSON.parse(removed.stdout[0] ?? "null")).toEqual({
      ok: false,
      error: { code: "usage", message: 'unknown command "operations"' },
    });

    const projectCheck = capture();
    expect(await runCli(["check", "--json"], { io: projectCheck.io })).toBe(2);
    expect(JSON.parse(projectCheck.stdout[0] ?? "null")).toEqual({
      ok: false,
      error: { code: "usage", message: "check requires --workspace" },
    });
  });
});
