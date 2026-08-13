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
    const paths = [
      "package.json",
      "LICENSE",
      "plugin/server.ts",
      "dist/server.js",
      "dist/server.meta.json",
    ];
    const run = vi.fn<CommandRunner>((_command, args) => ({
      status: 0,
      stdout: args[0] === "pm"
        ? [
            ...paths.map((path) => `packed 1KB ${path}`),
            `Total files: ${paths.length}`,
          ].join("\n")
        : "",
      stderr: "",
    }));
    const output = capture();
    expect(await runCli(["verify", "--json"], {
      cwd: root,
      io: output.io,
      run,
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
