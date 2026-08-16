import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addOperation,
  initializeProject,
  runCli,
  type CommandRunner,
  type CliIo,
} from "../src/index.js";
import {
  commandResult,
  makeOperationRequireInput,
  seedProjectExecutables,
  testEnvironment,
  writeBuildMetadata,
} from "./helpers.js";

const roots: string[] = [];

function temporaryProject(): string {
  const root = mkdtempSync(join(tmpdir(), "bb-kit-command-"));
  roots.push(root);
  initializeProject(root, {
    kind: "backend",
    packageName: "@acme/bb-plugin-example",
    syncTypes: false,
    install: false,
  });
  return root;
}

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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bb-kit command interface", () => {
  it("emits stable JSON for discovery and errors", async () => {
    const root = temporaryProject();
    addOperation(root, "reports.get", "query");
    const output = capture();
    expect(await runCli(["operations", "--json"], { cwd: root, io: output.io })).toBe(0);
    expect(JSON.parse(output.stdout[0] ?? "null")).toEqual([
      {
        identity: "reports.get",
        kind: "query",
        risk: null,
        rpcMethod: "reports_get",
        input: { mode: "none" },
        metadataError: null,
      },
    ]);

    const invalid = capture();
    expect(await runCli(["operations", "--wat", "--json"], { cwd: root, io: invalid.io })).toBe(2);
    expect(JSON.parse(invalid.stdout[0] ?? "null")).toEqual({
      ok: false,
      error: { code: "usage", message: "unknown option --wat" },
    });
  });

  it("requires confirmation before destructive invocation", async () => {
    const root = temporaryProject();
    addOperation(root, "reports.delete", "command", "destructive");
    makeOperationRequireInput(
      root,
      "reports.delete",
      "command",
      { id: "R-1" },
      "destructive",
    );
    const request = vi.fn<typeof fetch>();
    const output = capture();
    expect(await runCli(
      ["invoke", "reports.delete", "--input", '{"id":"R-1"}', "--json"],
      { cwd: root, io: output.io, fetch: request },
    )).toBe(1);
    expect(request).not.toHaveBeenCalled();
    expect(JSON.parse(output.stdout[0] ?? "null")).toEqual({
      ok: false,
      error: {
        code: "confirmation_required",
        message: "reports.delete is destructive; re-run with --confirm after reviewing the input",
      },
    });
  });

  it("invokes the locked native RPC method without a GUI", async () => {
    const root = temporaryProject();
    addOperation(root, "reports.refresh", "command", "mutating");
    makeOperationRequireInput(
      root,
      "reports.refresh",
      "command",
      { scope: "all" },
      "mutating",
    );
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ok: true,
      result: { refreshed: true },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const output = capture();
    expect(await runCli(
      [
        "invoke",
        "reports.refresh",
        "--input",
        '{"scope":"all"}',
        "--server",
        "http://127.0.0.1:39999",
        "--json",
      ],
      { cwd: root, io: output.io, fetch: request },
    )).toBe(0);
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:39999/api/v1/plugins/example/rpc/reports_refresh");
    expect(init?.body).toBe('{"scope":"all"}');
    expect(JSON.parse(output.stdout[0] ?? "null")).toEqual({
      ok: true,
      operation: "reports.refresh",
      pluginId: "example",
      rpcMethod: "reports_refresh",
      kind: "command",
      risk: "mutating",
      result: { refreshed: true },
    });
  });

  it("sends null only for omitted canonical no-input operations", async () => {
    const root = temporaryProject();
    addOperation(root, "reports.get", "query");
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ok: true,
      result: {},
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const output = capture();
    expect(await runCli(["invoke", "reports.get", "--json"], {
      cwd: root,
      io: output.io,
      fetch: request,
    })).toBe(0);
    expect(request.mock.calls[0]?.[1]?.body).toBe("null");

    const extra = capture();
    expect(await runCli(
      ["invoke", "reports.get", "--input", "null", "--json"],
      { cwd: root, io: extra.io, fetch: request },
    )).toBe(1);
    expect(JSON.parse(extra.stdout[0] ?? "null")).toEqual({
      ok: false,
      error: {
        code: "unexpected_operation_input",
        message: "reports.get accepts no input; omit --input",
      },
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("requires explicit input for every other schema", async () => {
    const root = temporaryProject();
    addOperation(root, "reports.nullable", "query");
    makeOperationRequireInput(root, "reports.nullable", "query", null);
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ok: true,
      result: {},
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const missing = capture();
    expect(await runCli(["invoke", "reports.nullable", "--json"], {
      cwd: root,
      io: missing.io,
      fetch: request,
    })).toBe(1);
    expect(JSON.parse(missing.stdout[0] ?? "null")).toEqual({
      ok: false,
      error: {
        code: "missing_operation_input",
        message: "reports.nullable requires input. Example: null. Run: bb-kit invoke reports.nullable --input 'null'",
      },
    });
    expect(request).not.toHaveBeenCalled();

    const explicit = capture();
    expect(await runCli(
      ["invoke", "reports.nullable", "--input", "null", "--json"],
      { cwd: root, io: explicit.io, fetch: request },
    )).toBe(0);
    expect(request.mock.calls[0]?.[1]?.body).toBe("null");
  });

  it("prints command-local help without reading operation metadata", async () => {
    const output = capture();
    expect(await runCli(["invoke", "--help"], {
      cwd: join(tmpdir(), "not-a-plugin"),
      io: output.io,
    })).toBe(0);
    expect(output.stdout).toEqual([
      "Usage: bb-kit invoke <module.name> [--input <json|@file>] [--confirm] [--server <url>] [--json]",
    ]);
    expect(output.stderr).toEqual([]);
  });

  it("keeps init option values out of the target path", async () => {
    const parent = mkdtempSync(join(tmpdir(), "bb-kit-init-command-"));
    roots.push(parent);
    const output = capture();
    expect(await runCli(
      ["init", "--kind", "fullstack", "--skip-types", "--skip-install", "--json"],
      { cwd: parent, io: output.io },
    )).toBe(0);
    const result = JSON.parse(output.stdout[0] ?? "null") as { created: string[] };
    expect(result.created).toContain("plugin/app.tsx");
  });

  it("exposes the complete verification gate as stable JSON", async () => {
    const root = temporaryProject();
    seedProjectExecutables(root);
    writeBuildMetadata(root);
    const paths = [
      "package.json",
      "LICENSE",
      "plugin/server.ts",
      "dist/server.js",
      "dist/server.meta.json",
    ];
    const run = vi.fn<CommandRunner>((request) => {
      if (request.args[0] === "--version") {
        return commandResult({ stdout: "0.38.0\n" });
      }
      return commandResult({
        stdout: request.args[0] === "pm"
          ? [
            ...paths.map((path) => `packed 1KB ${path}`),
            `Total files: ${paths.length}`,
          ].join("\n")
          : "",
      });
    });
    const output = capture();
    expect(await runCli(["verify", "--json"], {
      cwd: root,
      io: output.io,
      run,
      env: testEnvironment(),
    })).toBe(0);
    expect(JSON.parse(output.stdout[0] ?? "null")).toEqual(expect.objectContaining({
      ok: true,
      diagnostics: [],
      steps: expect.arrayContaining([
        expect.objectContaining({ name: "pack", status: "passed" }),
      ]),
    }));
  });
});
