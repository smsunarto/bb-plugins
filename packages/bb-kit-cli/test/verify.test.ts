import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeProject,
  verifyProject,
  type CommandRunner,
} from "../src/index.js";
import { checkPackedPackage, packedPaths } from "../src/package.js";

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
    expect(() => packedPaths([
      "packed 1KB package.json",
      "Total files: 2",
    ].join("\n"))).toThrow(/listed 1 files but reported 2/);
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
  it("runs checks in order and validates the packed plugin", () => {
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
      stdout: args[1] === "pack" ? packOutput(paths) : "",
      stderr: "",
    }));
    const result = verifyProject(root, { run });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.steps.map((step) => [step.name, step.status])).toEqual([
      ["lint", "passed"],
      ["typecheck", "passed"],
      ["test", "passed"],
      ["build", "passed"],
      ["pack", "passed"],
    ]);
    expect(run.mock.calls.map((call) => call[1].join(" "))).toEqual([
      "run lint",
      "run typecheck",
      "run test",
      "run build",
      "pm pack --dry-run",
    ]);
  });

  it("stops after a failed step and keeps its actionable output", () => {
    const root = temporaryProject();
    const run = vi.fn<CommandRunner>(() => ({
      status: 1,
      stdout: "",
      stderr: "lint failed at plugin/server.ts:1 token=secret-value",
    }));
    const result = verifyProject(root, { run });
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toEqual({
      name: "lint",
      command: "bun run lint",
      status: "failed",
      detail: "lint failed at plugin/server.ts:1 token=[REDACTED]",
    });
    expect(result.steps.slice(1).every((step) => step.status === "skipped")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });
});
