import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeProject, verifyProject, type CommandRunner } from "../src/index.js";
import { checkPackedPackage, packedPaths } from "../src/package.js";
import { compatibility } from "../src/compatibility.js";
import {
  commandResult,
  seedProjectExecutables,
  testEnvironment,
  writeBuildMetadata,
  writeVendoredDeclaration,
} from "./helpers.js";

const roots: string[] = [];

function temporaryProject(): string {
  const root = mkdtempSync(join(tmpdir(), "bb-kit-verify-"));
  roots.push(root);
  initializeProject(root, {
    kind: "backend",
    packageName: "@acme/bb-plugin-example",
    syncTypes: false,
    install: false,
  });
  return root;
}

function packOutput(paths: readonly string[]): string {
  return [
    "bun pack v1.3.10",
    ...paths.map((path) => `packed 1KB ${path}`),
    `Total files: ${paths.length}`,
  ].join("\n");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("package inspection", () => {
  it("parses dry-run pack output and fails closed on format drift", () => {
    expect(packedPaths(packOutput(["package.json", "LICENSE"]))).toEqual([
      "package.json",
      "LICENSE",
    ]);
    expect(() => packedPaths("packed 1KB package.json")).toThrow(/Total files/);
    expect(() => packedPaths(["packed 1KB package.json", "Total files: 2"].join("\n"))).toThrow(
      /listed 1 files but reported 2/,
    );
  });

  it("detects a missing transitive source fallback file", () => {
    const root = temporaryProject();
    writeFileSync(
      join(root, "plugin/server.ts"),
      'import "./helper.js";\nexport default function plugin() {}\n',
    );
    writeFileSync(join(root, "plugin/helper.ts"), "export const value = 1;\n");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const diagnostics = checkPackedPackage(root, manifest, [
      "package.json",
      "LICENSE",
      "plugin/server.ts",
      "dist/server.meta.json",
    ]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "BBK405", file: "plugin/helper.ts" }),
    ]);
  });
});

describe("project verification", () => {
  it("runs no project tool when the bb CLI is wrong", () => {
    const root = temporaryProject();
    seedProjectExecutables(root);
    const run = vi.fn<CommandRunner>(() => commandResult({ stdout: "0.36.0\n" }));
    const result = verifyProject(root, { run, env: testEnvironment() });
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        steps: [],
        error: expect.objectContaining({ code: "bb_cli_version_mismatch" }),
      }),
    );
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0].args).toEqual(["--version"]);
  });

  it("runs checks in order and validates the packed plugin", () => {
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
    const run = vi.fn<CommandRunner>((request) =>
      commandResult({
        stdout:
          request.args[0] === "--version"
            ? `${compatibility.bbCliVersion}\n`
            : request.args[0] === "pm"
              ? packOutput(paths)
              : "",
      }),
    );
    const result = verifyProject(root, { run, env: testEnvironment() });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.steps.map((step) => [step.name, step.status])).toEqual([
      ["lint", "passed"],
      ["typecheck", "passed"],
      ["test", "passed"],
      ["build", "passed"],
      ["pack", "passed"],
    ]);
    expect(run.mock.calls.map(([request]) => request.args.join(" "))).toEqual([
      "--version",
      "",
      "--noEmit",
      "test",
      "plugin build .",
      "pm pack --dry-run",
    ]);
  });

  it("stops after a failed step and keeps its actionable output", () => {
    const root = temporaryProject();
    seedProjectExecutables(root);
    const run = vi.fn<CommandRunner>((request) =>
      request.args[0] === "--version"
        ? commandResult({ stdout: `${compatibility.bbCliVersion}\n` })
        : commandResult({
            status: 1,
            stderr: "lint failed at plugin/server.ts:1 token=secret-value",
          }),
    );
    const result = verifyProject(root, { run, env: testEnvironment() });
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toEqual({
      name: "lint",
      command: expect.stringMatching(/node_modules\/.bin\/oxlint$/),
      status: "failed",
      detail: "lint failed at plugin/server.ts:1 token=[REDACTED]",
    });
    expect(result.steps.slice(1).every((step) => step.status === "skipped")).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops when a fixed tool changes a protected declaration", () => {
    const root = temporaryProject();
    seedProjectExecutables(root);
    const run = vi.fn<CommandRunner>((request) => {
      if (request.args[0] === "--version") {
        return commandResult({ stdout: `${compatibility.bbCliVersion}\n` });
      }
      writeVendoredDeclaration(root, "changed by lint\n");
      return commandResult();
    });
    const result = verifyProject(root, { run, env: testEnvironment() });
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "sdk_declaration_drift" }),
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: "BBK011" })]),
      }),
    );
    expect(result.steps.map((step) => [step.name, step.status])).toEqual([
      ["lint", "failed"],
      ["typecheck", "skipped"],
      ["test", "skipped"],
      ["build", "skipped"],
      ["pack", "skipped"],
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rechecks protected outputs after pack lifecycle work", () => {
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
        return commandResult({ stdout: `${compatibility.bbCliVersion}\n` });
      }
      if (request.args[0] === "pm") {
        writeVendoredDeclaration(root, "changed by pack\n");
        return commandResult({ stdout: packOutput(paths) });
      }
      return commandResult();
    });
    const result = verifyProject(root, { run, env: testEnvironment() });
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "sdk_declaration_drift" }),
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: "BBK011" })]),
      }),
    );
    expect(result.steps.at(-1)).toEqual(
      expect.objectContaining({
        name: "pack",
        status: "failed",
      }),
    );
  });
});
