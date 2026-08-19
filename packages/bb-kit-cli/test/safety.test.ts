import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProject,
  checkProject,
  initializeProject,
  type CommandRunner,
} from "../src/index.js";
import {
  compatibility,
  isCompatibleHostVersion,
} from "../src/compatibility.js";
import {
  inspectBbCli,
  ProcessError,
  selectBbCli,
} from "../src/process.js";
import {
  commandResult,
  fakeBbCli,
  repositoryRoot,
  testEnvironment,
  writeBuildMetadata,
  writeVendoredDeclaration,
} from "./helpers.js";

const roots: string[] = [];

function temporaryProject(kind: "backend" | "fullstack" = "backend"): string {
  const root = mkdtempSync(join(tmpdir(), "bb-kit-safety-"));
  roots.push(root);
  initializeProject(root, {
    kind,
    packageName: "@acme/bb-plugin-example",
    syncTypes: false,
    install: false,
  });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("private compatibility contract", () => {
  it("matches the repository pin, SDK package, and the published host shims", () => {
    const rootManifest = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { config: { bbVersion: string } };
    expect(compatibility.bbCliVersion).toBe(rootManifest.config.bbVersion);
    const [major, minor, patch] = compatibility.bbCliVersion.split(".").map(Number) as [
      number,
      number,
      number,
    ];
    expect(isCompatibleHostVersion(compatibility.bbCliVersion)).toBe(true);
    expect(isCompatibleHostVersion(`${major}.${minor}.${patch + 9}`)).toBe(true);
    expect(isCompatibleHostVersion(`${major}.${minor + 1}.0`)).toBe(true);
    expect(isCompatibleHostVersion(`${major}.${minor}.x`)).toBe(false);
    expect(isCompatibleHostVersion(`${compatibility.bbCliVersion}-beta.1`)).toBe(false);
    expect(isCompatibleHostVersion(`${major}.${minor - 1}.0`)).toBe(false);
    expect(isCompatibleHostVersion(`${major + 1}.0.0`)).toBe(false);
    expect(checkProject(temporaryProject("fullstack"))).toEqual([]);
    expect([
      ...compatibility.hostShims.server,
      ...compatibility.hostShims.frontend,
    ]).toEqual([
      "@get-bb/plugin-sdk",
      "@get-bb/plugin-sdk/app",
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@bb/plugin-sdk/app",
      "@pierre/diffs",
      "@pierre/diffs/react",
      "@radix-ui/react-alert-dialog",
      "@radix-ui/react-context-menu",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-hover-card",
      "@radix-ui/react-menubar",
      "@radix-ui/react-navigation-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-select",
      "@radix-ui/react-tooltip",
      "sonner",
      "vaul",
    ]);
  });

  it("fails closed on declarations, package escapes, unresolved imports, and shim subpaths", () => {
    const root = temporaryProject();
    writeVendoredDeclaration(root, "drift\n");
    writeFileSync(
      join(root, "plugin/server.ts"),
      [
        'import "../../outside.js";',
        'import "./missing.js";',
        'import "@pierre/diffs/edit";',
        "export default function plugin() {}",
        "",
      ].join("\n"),
    );
    const diagnostics = checkProject(root);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "BBK011" }),
      expect.objectContaining({ code: "BBK110" }),
      expect.objectContaining({ code: "BBK111" }),
      expect.objectContaining({ code: "BBK112" }),
    ]));
  });
});

describe("exact bb CLI selection", () => {
  it("rejects prerelease CLIs before probing their compatibility", () => {
    const run = vi.fn<CommandRunner>(() => commandResult({
      stdout: "bb 0.38.0-beta.1\n",
    }));
    expect(() => inspectBbCli(process.cwd(), testEnvironment(), run)).toThrow(
      expect.objectContaining({ code: "bb_cli_invalid" } satisfies Partial<ProcessError>),
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it("never falls back to PATH after an invalid explicit BB_CLI", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-kit-path-"));
    roots.push(directory);
    const pathBb = join(directory, "bb");
    writeFileSync(pathBb, "#!/bin/sh\nexit 0\n");
    chmodSync(pathBb, 0o755);
    const run = vi.fn<CommandRunner>();
    expect(() => selectBbCli(directory, {
      PATH: directory,
      BB_CLI: "relative/bb",
    }, compatibility.bbCliVersion, run)).toThrow(expect.objectContaining({
      code: "bb_cli_invalid",
    } satisfies Partial<ProcessError>));
    expect(run).not.toHaveBeenCalled();
  });

  it("uses one protected child environment", () => {
    const run = vi.fn<CommandRunner>(() => commandResult({
      stdout: `${compatibility.bbCliVersion}\n`,
    }));
    const selected = selectBbCli(process.cwd(), {
      ...testEnvironment(),
      BB_CLI_REEXEC: "1",
    }, compatibility.bbCliVersion, run);
    expect(selected.path).toBe(fakeBbCli);
    expect(selected.env.BB_CLI).toBeUndefined();
    expect(selected.env.BB_CLI_REEXEC).toBeUndefined();
    expect(run.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      file: fakeBbCli,
      args: ["--version"],
    }));
  });

  it("does not create a type-syncing project when the CLI version is wrong", () => {
    const parent = mkdtempSync(join(tmpdir(), "bb-kit-init-preflight-"));
    roots.push(parent);
    const target = join(parent, "nested", "plugin");
    const run = vi.fn<CommandRunner>(() => commandResult({ stdout: "0.36.0\n" }));
    expect(() => initializeProject(target, {
      install: false,
      env: testEnvironment(),
      run,
    })).toThrow(expect.objectContaining({
      code: "bb_cli_version_mismatch",
    } satisfies Partial<ProcessError>));
    expect(existsSync(target)).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("owned builds", () => {
  it("calls the selected bb directly and never delegates to package scripts", () => {
    const root = temporaryProject();
    writeBuildMetadata(root);
    const run = vi.fn<CommandRunner>((request) => commandResult({
      stdout: request.args[0] === "--version" ? `${compatibility.bbCliVersion}\n` : "",
    }));
    const result = buildProject(root, { run, env: testEnvironment() });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: "passed",
      selectedBbCli: {
        path: fakeBbCli,
        source: "BB_CLI",
        version: compatibility.bbCliVersion,
      },
    }));
    expect(run.mock.calls.map(([request]) => ({
      file: request.file,
      args: request.args,
    }))).toEqual([
      { file: fakeBbCli, args: ["--version"] },
      { file: fakeBbCli, args: ["plugin", "build", "."] },
    ]);
  });

  it("runs no build for the wrong CLI and fails on build output drift", () => {
    const wrongRoot = temporaryProject();
    const wrongRun = vi.fn<CommandRunner>(() => commandResult({ stdout: "0.36.0\n" }));
    expect(buildProject(wrongRoot, {
      run: wrongRun,
      env: testEnvironment(),
    })).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "bb_cli_version_mismatch" }),
    }));
    expect(wrongRun).toHaveBeenCalledOnce();

    const driftRoot = temporaryProject();
    writeBuildMetadata(driftRoot);
    const driftRun = vi.fn<CommandRunner>((request) => {
      if (request.args[0] === "--version") {
        return commandResult({ stdout: `${compatibility.bbCliVersion}\n` });
      }
      writeVendoredDeclaration(driftRoot, "drift\n");
      return commandResult();
    });
    expect(buildProject(driftRoot, {
      run: driftRun,
      env: testEnvironment(),
    })).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "sdk_declaration_drift" }),
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "BBK011" }),
      ]),
    }));

    const metadataRoot = temporaryProject();
    const metadataRun = vi.fn<CommandRunner>((request) => {
      if (request.args[0] === "--version") {
        return commandResult({ stdout: `${compatibility.bbCliVersion}\n` });
      }
      writeBuildMetadata(metadataRoot);
      const path = join(metadataRoot, "dist/server.meta.json");
      const metadata = JSON.parse(readFileSync(path, "utf8")) as {
        builtWith: { bbVersion: string };
      };
      metadata.builtWith.bbVersion = "0.37.0";
      writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`);
      return commandResult();
    });
    expect(buildProject(metadataRoot, {
      run: metadataRun,
      env: testEnvironment(),
    })).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "build_metadata_mismatch" }),
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "BBK013" }),
      ]),
    }));
  });
});
