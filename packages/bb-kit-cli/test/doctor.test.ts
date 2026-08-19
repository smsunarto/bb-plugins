import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addOperation,
  doctorProject,
  initializeProject,
  type CommandRunner,
} from "../src/index.js";
import { compatibility } from "../src/compatibility.js";
import {
  commandResult,
  testEnvironment,
} from "./helpers.js";

const roots: string[] = [];

function temporaryProject(): string {
  const root = mkdtempSync(join(tmpdir(), "bb-kit-doctor-"));
  roots.push(root);
  initializeProject(root, {
    kind: "fullstack",
    packageName: "@acme/bb-plugin-example",
    syncTypes: false,
    install: false,
  });
  addOperation(root, "reports.get", "query");
  return root;
}

function doctorRunner(root: string, overrides: {
  hostVersion?: string;
  rootDir?: string;
  enabled?: boolean;
  status?: string;
} = {}): CommandRunner {
  return (request) => {
    if (request.args[0] === "--version") {
      return commandResult({ stdout: `${compatibility.bbCliVersion}\n` });
    }
    if (request.args.join(" ") === "settings version --json") {
      return commandResult({
        stdout: JSON.stringify({
          currentVersion: overrides.hostVersion ?? compatibility.bbCliVersion,
        }),
      });
    }
    if (request.args.join(" ") === "plugin list --json") {
      return commandResult({
        stdout: JSON.stringify({
          plugins: [{
            id: "example",
            source: `path:${overrides.rootDir ?? root}`,
            rootDir: overrides.rootDir ?? root,
            version: "0.1.0",
            enabled: overrides.enabled ?? true,
            status: overrides.status ?? "running",
            statusDetail: null,
            app: {
              bundle: {
                sdkVersion: compatibility.pluginSdk.version,
                compatible: true,
              },
            },
          }],
        }),
      });
    }
    throw new Error(`doctor issued unsupported command: ${request.args.join(" ")}`);
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("read-only doctor", () => {
  it("uses only supported read commands and suggests the first query", () => {
    const root = temporaryProject();
    const run = vi.fn<CommandRunner>(doctorRunner(root));
    const report = doctorProject(root, { run, env: testEnvironment() });
    expect(report).toEqual(expect.objectContaining({
      ok: true,
      host: { version: compatibility.bbCliVersion, compatible: true },
      plugin: expect.objectContaining({
        id: "example",
        found: true,
        sourceMatches: true,
        appSdkVersion: compatibility.pluginSdk.version,
        appCompatible: true,
      }),
      suggestedQuery: "bb-kit invoke reports.get",
      errors: [],
    }));
    expect(run.mock.calls.map(([request]) => request.args.join(" "))).toEqual([
      "--version",
      "settings version --json",
      "plugin list --json",
    ]);
    expect(run.mock.calls.flatMap(([request]) => request.args)).not.toEqual(
      expect.arrayContaining(["install", "reload", "enable", "disable", "remove", "run"]),
    );
  });

  it("reports incompatible hosts, wrong sources, and failed plugins without probing RPC", () => {
    const root = temporaryProject();
    const other = mkdtempSync(join(tmpdir(), "bb-kit-doctor-other-"));
    roots.push(other);
    const run = vi.fn<CommandRunner>(doctorRunner(root, {
      hostVersion: "1.0.0",
      rootDir: other,
      enabled: false,
      status: "failed",
    }));
    const report = doctorProject(root, { run, env: testEnvironment() });
    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toEqual([
      "doctor_host_incompatible",
      "doctor_plugin_source_mismatch",
      "doctor_plugin_not_running",
    ]);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
