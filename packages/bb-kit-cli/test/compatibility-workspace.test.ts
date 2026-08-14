import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runCli,
  type CliIo,
  type CommandRunner,
} from "../src/index.js";
import {
  checkWorkspaceCompatibility,
  compatibilityContractSource,
  inspectCompatibility,
  upgradeCompatibility,
} from "../src/compatibility-workspace.js";
import {
  compatibility,
  type CompatibilityContract,
} from "../src/compatibility.js";
import {
  commandResult,
  repositoryRoot,
} from "./helpers.js";

const roots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function testContract(
  version: string,
  sdkVersion: string,
  server: string,
  app: string,
  frontend: readonly string[] = ["@bb/plugin-sdk/app", "react", "sonner"],
): CompatibilityContract {
  const [majorText, minorText] = version.split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  return {
    bbCliVersion: version,
    engines: {
      bb: `>=${version} <${major}.${minor + 1}.0`,
      bbPluginSdk: `^${sdkVersion}`,
    },
    pluginSdk: {
      version: sdkVersion,
      major: Number(sdkVersion.split(".")[0]),
      artifactFormatVersion: 1,
    },
    declarations: {
      server: { path: "types/bb-plugin-sdk.d.ts", sha256: sha256(server) },
      app: { path: "types/bb-plugin-sdk-app.d.ts", sha256: sha256(app) },
    },
    hostShims: {
      server: ["@bb/plugin-sdk"],
      frontend,
    },
    registryUrl: `https://raw.githubusercontent.com/get-bb/bb/desktop-v${version}/packages/plugin-registry/r/{name}.json`,
  };
}

interface SeedOptions {
  readonly fullstack?: boolean;
  readonly metadata?: boolean;
}

function seedWorkspace(
  contract: CompatibilityContract,
  declarations: { readonly server: string; readonly app: string },
  options: SeedOptions = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "bb-kit-workspace-"));
  roots.push(root);
  mkdirSync(join(root, "packages/bb-kit-cli/src"), { recursive: true });
  mkdirSync(join(root, "plugins/example/types"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "test-workspace",
    private: true,
    config: { bbVersion: contract.bbCliVersion },
    untouched: { root: true },
  }, null, 2)}\n`);
  writeFileSync(
    join(root, "packages/bb-kit-cli/src/compatibility-contract.ts"),
    compatibilityContractSource(contract),
  );
  writeFileSync(join(root, "plugins/example/package.json"), `${JSON.stringify({
    name: "@acme/bb-plugin-example",
    version: "0.1.0",
    untouched: { plugin: true },
    engines: contract.engines,
    bb: {
      server: "./server.ts",
      ...(options.fullstack ? { app: "./app.tsx" } : {}),
    },
  }, null, 2)}\n`);
  writeFileSync(join(root, "plugins/example/types/bb-plugin-sdk.d.ts"), declarations.server);
  if (options.fullstack) {
    writeFileSync(join(root, "plugins/example/types/bb-plugin-sdk-app.d.ts"), declarations.app);
  }
  writeFileSync(join(root, "plugins/example/components.json"), `${JSON.stringify({
    registries: {
      "@bb": contract.registryUrl,
      "@acme": "https://example.test/{name}.json",
    },
    untouched: true,
  }, null, 2)}\n`);
  if (options.metadata) {
    mkdirSync(join(root, "plugins/example/dist"), { recursive: true });
    const metadata = {
      sdkMajor: contract.pluginSdk.major,
      sdkVersion: contract.pluginSdk.version,
      artifactFormatVersion: contract.pluginSdk.artifactFormatVersion,
      pluginId: "example",
      pluginVersion: "0.1.0",
      builtWith: {
        bbVersion: contract.bbCliVersion,
        pluginSdkVersion: contract.pluginSdk.version,
      },
    };
    writeFileSync(
      join(root, "plugins/example/dist/server.meta.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    if (options.fullstack) {
      writeFileSync(
        join(root, "plugins/example/dist/app.meta.json"),
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
    }
  }
  return root;
}

function fakeBb(
  root: string,
  contract: CompatibilityContract,
  declarations: { readonly server: string; readonly app: string },
): { readonly env: NodeJS.ProcessEnv; readonly run: ReturnType<typeof vi.fn<CommandRunner>> } {
  const path = join(root, "selected-bb.js");
  const slots = Object.fromEntries(contract.hostShims.frontend.map((specifier) => [
    specifier,
    specifier === "@bb/plugin-sdk/app" ? "pluginSdkApp" : `host:${specifier}`,
  ]));
  writeFileSync(path, `#!/usr/bin/env node\nconst hostSlots = ${JSON.stringify(slots)};\n`);
  chmodSync(path, 0o755);
  const run = vi.fn<CommandRunner>((request) => {
    if (request.args.length === 1 && request.args[0] === "--version") {
      return commandResult({ stdout: `bb ${contract.bbCliVersion}\n` });
    }
    if (request.args.join(" ") === "plugin new probe --app") {
      const probe = join(request.cwd, "bb-plugin-probe");
      mkdirSync(join(probe, "types"), { recursive: true });
      writeFileSync(join(probe, "package.json"), `${JSON.stringify({
        engines: { bbPluginSdk: contract.engines.bbPluginSdk },
      }, null, 2)}\n`);
      writeFileSync(join(probe, "components.json"), `${JSON.stringify({
        registries: { "@bb": contract.registryUrl },
      }, null, 2)}\n`);
      writeFileSync(join(probe, "types/bb-plugin-sdk.d.ts"), declarations.server);
      writeFileSync(join(probe, "types/bb-plugin-sdk-app.d.ts"), declarations.app);
      return commandResult();
    }
    if (request.args.join(" ") === "plugin build .") {
      mkdirSync(join(request.cwd, "dist"), { recursive: true });
      const metadata = {
        sdkVersion: contract.pluginSdk.version,
        sdkMajor: contract.pluginSdk.major,
        artifactFormatVersion: contract.pluginSdk.artifactFormatVersion,
      };
      writeFileSync(
        join(request.cwd, "dist/server.meta.json"),
        `${JSON.stringify(metadata)}\n`,
      );
      writeFileSync(
        join(request.cwd, "dist/app.meta.json"),
        `${JSON.stringify(metadata)}\n`,
      );
      return commandResult();
    }
    return commandResult({ status: 1, stderr: `unexpected command: ${request.args.join(" ")}` });
  });
  return { env: { ...process.env, BB_CLI: path }, run };
}

function snapshot(root: string): Map<string, string> {
  const values = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) values.set(relative(root, path), readFileSync(path, "utf8"));
    }
  };
  visit(root);
  return values;
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

describe("workspace compatibility policy", () => {
  it("reports every partial or optimistic compatibility change", () => {
    const declarations = { server: "server target\n", app: "app target\n" };
    const contract = testContract("0.38.2", "0.5.0", declarations.server, declarations.app);
    const root = seedWorkspace(contract, declarations, { fullstack: true, metadata: true });

    const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      config: { bbVersion: string };
    };
    rootManifest.config.bbVersion = "0.37.0";
    writeFileSync(join(root, "package.json"), `${JSON.stringify(rootManifest, null, 2)}\n`);
    writeFileSync(
      join(root, "packages/bb-kit-cli/src/compatibility-contract.ts"),
      "// edited by hand\nexport const compatibility = {};\n",
    );
    const manifestPath = join(root, "plugins/example/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      engines: { bb: string; bbPluginSdk: string };
    };
    manifest.engines = { bb: ">=0.38.0", bbPluginSdk: "^0.4.1" };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(root, "plugins/example/types/bb-plugin-sdk.d.ts"), "drift\n");
    const componentsPath = join(root, "plugins/example/components.json");
    const components = JSON.parse(readFileSync(componentsPath, "utf8")) as {
      registries: Record<string, string>;
    };
    components.registries["@bb"] = "https://stale.test/{name}.json";
    writeFileSync(componentsPath, `${JSON.stringify(components, null, 2)}\n`);
    const metadataPath = join(root, "plugins/example/dist/server.meta.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      builtWith: { bbVersion: string };
    };
    metadata.builtWith.bbVersion = "0.37.0";
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    const diagnostics = checkWorkspaceCompatibility(root, contract);
    expect(new Set(diagnostics.map((value) => value.code))).toEqual(new Set([
      "BBKW001",
      "BBKW002",
      "BBKW005",
      "BBKW006",
      "BBKW007",
      "BBK011",
      "BBK013",
    ]));
    expect(diagnostics.find((value) => value.code === "BBKW005")?.message).toContain(
      `expected ${JSON.stringify(contract.engines.bb)}`,
    );
  });

  it("inspects a selected release without changing the workspace", () => {
    const oldDeclarations = { server: "old server\n", app: "old app\n" };
    const oldContract = testContract("0.37.0", "0.4.1", oldDeclarations.server, oldDeclarations.app);
    const targetDeclarations = { server: "new server\n", app: "new app\n" };
    const target = testContract("0.38.2", "0.5.0", targetDeclarations.server, targetDeclarations.app);
    const root = seedWorkspace(oldContract, oldDeclarations, { fullstack: true });
    const selected = fakeBb(root, target, targetDeclarations);
    const before = snapshot(root);

    const result = inspectCompatibility(root, selected);

    expect(result.target).toEqual(target);
    expect(result.changes).toEqual(expect.arrayContaining([
      "package.json",
      "packages/bb-kit-cli/src/compatibility-contract.ts",
      "plugins/example/package.json",
      "plugins/example/components.json",
      "plugins/example/types/bb-plugin-sdk.d.ts",
      "plugins/example/types/bb-plugin-sdk-app.d.ts",
    ]));
    expect(snapshot(root)).toEqual(before);
    expect(selected.run.mock.calls.map(([request]) => request.args)).toEqual([
      ["--version"],
      ["plugin", "new", "probe", "--app"],
      ["plugin", "build", "."],
    ]);
  });

  it("upgrades every owned target together, preserves other fields, and is idempotent", () => {
    const oldDeclarations = { server: "old server\n", app: "old app\n" };
    const oldContract = testContract("0.37.0", "0.4.1", oldDeclarations.server, oldDeclarations.app);
    const targetDeclarations = { server: "new server\n", app: "new app\n" };
    const target = testContract("0.38.2", "0.5.0", targetDeclarations.server, targetDeclarations.app);
    const root = seedWorkspace(oldContract, oldDeclarations, { fullstack: true });
    const selected = fakeBb(root, target, targetDeclarations);

    const result = upgradeCompatibility(root, selected);

    expect(result.updated).toBe(true);
    expect(checkWorkspaceCompatibility(root, target)).toEqual([]);
    const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      config: { bbVersion: string };
      untouched: unknown;
    };
    expect(rootManifest).toEqual(expect.objectContaining({
      config: { bbVersion: target.bbCliVersion },
      untouched: { root: true },
    }));
    const pluginManifest = JSON.parse(
      readFileSync(join(root, "plugins/example/package.json"), "utf8"),
    ) as { engines: unknown; untouched: unknown };
    expect(pluginManifest).toEqual(expect.objectContaining({
      engines: target.engines,
      untouched: { plugin: true },
    }));
    const components = JSON.parse(
      readFileSync(join(root, "plugins/example/components.json"), "utf8"),
    ) as { registries: Record<string, string>; untouched: unknown };
    expect(components).toEqual(expect.objectContaining({
      registries: {
        "@bb": target.registryUrl,
        "@acme": "https://example.test/{name}.json",
      },
      untouched: true,
    }));
    expect(readFileSync(join(root, "plugins/example/types/bb-plugin-sdk.d.ts"), "utf8"))
      .toBe(targetDeclarations.server);
    expect(readFileSync(join(root, "plugins/example/types/bb-plugin-sdk-app.d.ts"), "utf8"))
      .toBe(targetDeclarations.app);

    const second = upgradeCompatibility(root, selected);
    expect(second).toEqual(expect.objectContaining({ updated: false, changes: [] }));
    expect(selected.run.mock.calls.every(([request]) =>
      !request.args.some((argument) => ["install", "reload", "enable", "rpc"].includes(argument)),
    )).toBe(true);
  });

  it("does not turn upgrade into a downgrade escape hatch", () => {
    const currentDeclarations = { server: "current server\n", app: "current app\n" };
    const current = testContract(
      "0.38.2",
      "0.5.0",
      currentDeclarations.server,
      currentDeclarations.app,
    );
    const oldDeclarations = { server: "old server\n", app: "old app\n" };
    const old = testContract("0.37.0", "0.4.1", oldDeclarations.server, oldDeclarations.app);
    const root = seedWorkspace(current, currentDeclarations, { fullstack: true });
    const selected = fakeBb(root, old, oldDeclarations);
    const before = snapshot(root);

    expect(() => upgradeCompatibility(root, selected)).toThrow(expect.objectContaining({
      code: "compatibility_downgrade_refused",
    }));
    expect(snapshot(root)).toEqual(before);
  });

  it("refuses linked write targets before changing any compatibility state", () => {
    const oldDeclarations = { server: "old server\n", app: "old app\n" };
    const oldContract = testContract("0.37.0", "0.4.1", oldDeclarations.server, oldDeclarations.app);
    const targetDeclarations = { server: "new server\n", app: "new app\n" };
    const target = testContract("0.38.2", "0.5.0", targetDeclarations.server, targetDeclarations.app);
    const root = seedWorkspace(oldContract, oldDeclarations);
    const declarationPath = join(root, "plugins/example/types/bb-plugin-sdk.d.ts");
    rmSync(declarationPath);
    symlinkSync("/dev/null", declarationPath);
    const selected = fakeBb(root, target, targetDeclarations);
    const packageBefore = readFileSync(join(root, "package.json"), "utf8");
    const pluginBefore = readFileSync(join(root, "plugins/example/package.json"), "utf8");
    const contractBefore = readFileSync(
      join(root, "packages/bb-kit-cli/src/compatibility-contract.ts"),
      "utf8",
    );

    expect(() => upgradeCompatibility(root, selected)).toThrow(expect.objectContaining({
      code: "compatibility_workspace_unsafe_target",
    }));
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(packageBefore);
    expect(readFileSync(join(root, "plugins/example/package.json"), "utf8")).toBe(pluginBefore);
    expect(readFileSync(
      join(root, "packages/bb-kit-cli/src/compatibility-contract.ts"),
      "utf8",
    )).toBe(contractBefore);
    expect(existsSync(declarationPath)).toBe(true);
  });

  it("restores all writes when the post-write workspace check fails", () => {
    const oldDeclarations = { server: "old server\n", app: "old app\n" };
    const oldContract = testContract("0.37.0", "0.4.1", oldDeclarations.server, oldDeclarations.app);
    const targetDeclarations = { server: "new server\n", app: "new app\n" };
    const target = testContract("0.38.2", "0.5.0", targetDeclarations.server, targetDeclarations.app);
    const root = seedWorkspace(oldContract, oldDeclarations);
    const typesPath = join(root, "plugins/example/types");
    rmSync(typesPath, { recursive: true });
    const pluginPath = join(root, "plugins/example/package.json");
    writeFileSync(pluginPath, [
      "{",
      '  "name": "@acme/bb-plugin-example",',
      '  "version": "0.1.0",',
      '  "engines": {',
      `    "bb": ${JSON.stringify(oldContract.engines.bb)},`,
      `    "bb": ${JSON.stringify(oldContract.engines.bb)},`,
      `    "bbPluginSdk": ${JSON.stringify(oldContract.engines.bbPluginSdk)}`,
      "  },",
      '  "bb": { "server": "./server.ts" }',
      "}",
      "",
    ].join("\n"));
    const selected = fakeBb(root, target, targetDeclarations);
    const before = snapshot(root);

    expect(() => upgradeCompatibility(root, selected)).toThrow(expect.objectContaining({
      code: "compatibility_upgrade_invalid",
    }));
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(typesPath)).toBe(false);
  });
});

describe("workspace compatibility commands", () => {
  it("exposes both workspace check forms and rejects unsafe upgrade options", async () => {
    const declarations = {
      server: readFileSync(join(repositoryRoot, "plugins/dotfiles/types/bb-plugin-sdk.d.ts"), "utf8"),
      app: readFileSync(join(repositoryRoot, "plugins/dotfiles/types/bb-plugin-sdk-app.d.ts"), "utf8"),
    };
    const root = seedWorkspace(compatibility, declarations, { fullstack: true });
    const check = capture();
    expect(await runCli(["check", "--workspace", "--json"], {
      cwd: join(root, "plugins/example"),
      io: check.io,
    })).toBe(0);
    expect(JSON.parse(check.stdout[0] ?? "null")).toEqual([]);

    const compatibilityCheck = capture();
    expect(await runCli(["compatibility", "check", "--json"], {
      cwd: root,
      io: compatibilityCheck.io,
    })).toBe(0);
    expect(JSON.parse(compatibilityCheck.stdout[0] ?? "null")).toEqual([]);

    const selected = fakeBb(root, compatibility, declarations);
    const inspect = capture();
    expect(await runCli(["compatibility", "inspect", "--json"], {
      cwd: root,
      io: inspect.io,
      ...selected,
    })).toBe(0);
    expect(JSON.parse(inspect.stdout[0] ?? "null")).toEqual(expect.objectContaining({
      ok: true,
      target: compatibility,
      changes: [],
    }));

    const unsafe = capture();
    const callsBefore = selected.run.mock.calls.length;
    expect(await runCli(["compatibility", "upgrade", "--force", "--json"], {
      cwd: root,
      io: unsafe.io,
      ...selected,
    })).toBe(2);
    expect(JSON.parse(unsafe.stdout[0] ?? "null")).toEqual({
      ok: false,
      error: { code: "usage", message: "unknown option --force" },
    });
    expect(selected.run.mock.calls).toHaveLength(callsBefore);
  });
});
