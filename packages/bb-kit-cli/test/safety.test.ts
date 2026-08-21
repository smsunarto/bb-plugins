import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/index.js";
import { compatibility, isCompatibleHostVersion } from "../src/compatibility.js";
import { inspectBbCli, ProcessError, selectBbCli } from "../src/process.js";
import { commandResult, fakeBbCli, repositoryRoot, testEnvironment } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("private compatibility contract", () => {
  it("matches the repository pin, SDK package, and the published host shims", () => {
    const rootManifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      config: { bbVersion: string };
    };
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
    expect([...compatibility.hostShims.server, ...compatibility.hostShims.frontend]).toEqual([
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
});

describe("exact bb CLI selection", () => {
  it("rejects prerelease CLIs before probing their compatibility", () => {
    const run = vi.fn<CommandRunner>(() =>
      commandResult({
        stdout: "bb 0.38.0-beta.1\n",
      }),
    );
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
    expect(() =>
      selectBbCli(
        directory,
        {
          PATH: directory,
          BB_CLI: "relative/bb",
        },
        compatibility.bbCliVersion,
        run,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "bb_cli_invalid",
      } satisfies Partial<ProcessError>),
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("uses one protected child environment", () => {
    const run = vi.fn<CommandRunner>(() =>
      commandResult({
        stdout: `${compatibility.bbCliVersion}\n`,
      }),
    );
    const selected = selectBbCli(
      process.cwd(),
      {
        ...testEnvironment(),
        BB_CLI_REEXEC: "1",
      },
      compatibility.bbCliVersion,
      run,
    );
    expect(selected.path).toBe(fakeBbCli);
    expect(selected.env.BB_CLI).toBeUndefined();
    expect(selected.env.BB_CLI_REEXEC).toBeUndefined();
    expect(run.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        file: fakeBbCli,
        args: ["--version"],
      }),
    );
  });
});
