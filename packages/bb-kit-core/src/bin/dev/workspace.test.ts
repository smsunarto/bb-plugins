import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDev } from "./command.ts";
import type {
  CapturedCommand,
  DevManager,
  InstanceResult,
  StartOptions,
} from "./manager.ts";
import {
  driftingConfigKeys,
  loadWorkspaceDefinition,
  runWorkspace,
  type WorkspaceRuntime,
} from "./workspace.ts";

test("workspace profile discovers plugins and rejects policy drift", () => {
  const fixture = createWorkspace();
  const definition = loadWorkspaceDefinition(fixture.root);
  assert.deepEqual(
    definition.plugins.map((plugin) => plugin.id),
    ["alpha", "beta"],
  );
  assert.equal(definition.profile.theme, "plugin:monokai:bb-monokai");

  const invalid = createWorkspace({ watchExclude: ["missing"] });
  assert.throws(
    () => loadWorkspaceDefinition(invalid.root),
    (error: unknown) => hasCode(error, "invalid_workspace_profile"),
  );
});

test("workspace reconciliation is ordered, safe, and idempotent", async () => {
  const fixture = createWorkspace();
  const runtime = new FakeRuntime(fixture.root, fixture.pluginRoots);

  const first = await runWorkspace(
    runtime,
    { watch: false, name: "plugins" },
    {
      sleep: async () => {},
    },
  );
  assert.deepEqual(first.plugins.built, ["alpha", "beta"]);
  assert.deepEqual(first.plugins.installed, ["beta"]);
  assert.deepEqual(first.plugins.unchanged, ["alpha"]);
  assert.deepEqual(first.plugins.enabled, ["alpha"]);
  assert.deepEqual(first.baseline.experimentsSet, ["editMessages"]);
  assert.deepEqual(first.baseline.configKeysReset, [{ pluginId: "alpha", key: "tidy" }]);
  assert.equal(first.baseline.themeChanged, true);
  assert.deepEqual(runtime.events.slice(0, 4), [
    "start",
    `run:${fixture.root}:bun run build:framework`,
    `run:${fixture.pluginRoots.alpha}:bun run build`,
    `run:${fixture.pluginRoots.beta}:bun run build`,
  ]);

  const writesBeforeRepeat = runtime.bbWrites;
  const second = await runWorkspace(
    runtime,
    { watch: false, name: "plugins" },
    {
      sleep: async () => {},
    },
  );
  assert.deepEqual(second.plugins.installed, []);
  assert.deepEqual(second.plugins.unchanged, ["alpha", "beta"]);
  assert.deepEqual(second.plugins.enabled, []);
  assert.deepEqual(second.baseline.experimentsSet, []);
  assert.deepEqual(second.baseline.configKeysReset, []);
  assert.equal(second.baseline.themeChanged, false);
  assert.equal(runtime.bbWrites, writesBeforeRepeat);
});

test("workspace watch uses selected packages and excludes agent-proxy", async () => {
  const fixture = createWorkspace({ watchExclude: ["beta"] });
  const runtime = new FakeRuntime(fixture.root, fixture.pluginRoots);
  await runWorkspace(runtime, { watch: true }, { sleep: async () => {} });
  assert.equal(
    runtime.events.at(-1),
    `run:${fixture.root}:bun run --filter @scope/bb-plugin-alpha --parallel --no-orphans dev`,
  );
});

test("workspace CLI keeps selectors and JSON stable and refuses attached or JSON watch modes", async () => {
  const fixture = createWorkspace();
  const runtime = new FakeRuntime(fixture.root, fixture.pluginRoots);
  const result = await runDev(
    [
      "workspace",
      "--name",
      "branch-test",
      "--revision",
      "origin:feature",
      "--repo",
      "/tmp/bb",
      "--json",
    ],
    { manager: runtime as unknown as DevManager },
  );
  assert.equal(result.exitCode, 0);
  const envelope = JSON.parse(result.stdout) as {
    ok: boolean;
    command: string;
    result: { plugins: { discovered: string[] } };
  };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "workspace");
  assert.deepEqual(envelope.result.plugins.discovered, ["alpha", "beta"]);
  assert.deepEqual(runtime.startOptions, {
    name: "branch-test",
    revision: "origin:feature",
    repository: "/tmp/bb",
    desktop: undefined,
    open: undefined,
    timeoutMs: undefined,
  });

  const attached = await runDev(["workspace", "--attach", "/tmp/bb", "--json"], {
    manager: runtime as unknown as DevManager,
  });
  assert.equal(attached.exitCode, 2);
  assert.equal(JSON.parse(attached.stdout).error.code, "invalid_arguments");

  const watchedJson = await runDev(["workspace", "--watch", "--json"], {
    manager: runtime as unknown as DevManager,
  });
  assert.equal(watchedJson.exitCode, 2);
  assert.equal(JSON.parse(watchedJson.stdout).error.code, "invalid_arguments");
});

test("drifting config excludes defaults, absent values, and secrets", () => {
  assert.deepEqual(
    driftingConfigKeys({
      schema: {
        changed: { default: true },
        same: { default: "value" },
        absent: { default: 1 },
        secret: { secret: true },
      },
      values: { changed: false, same: "value", secret: { set: true }, gone: 1 },
    }),
    ["changed", "gone"],
  );
});

type WorkspaceOverrides = {
  watchExclude?: string[];
};

function createWorkspace(overrides: WorkspaceOverrides = {}): {
  root: string;
  pluginRoots: { alpha: string; beta: string };
} {
  const root = mkdtempSync(join(tmpdir(), "bb-kit-workspace-"));
  const pluginRoots = {
    alpha: join(root, "plugins", "alpha"),
    beta: join(root, "plugins", "beta"),
  };
  for (const path of Object.values(pluginRoots)) mkdirSync(path, { recursive: true });
  writeJson(join(root, "package.json"), {
    name: "workspace",
    scripts: { "build:framework": "build framework" },
    bbKit: {
      devInstance: {
        schemaVersion: 1,
        pluginDirectory: "plugins",
        packageManager: "bun",
        beforeBuild: ["build:framework"],
        watchExclude: overrides.watchExclude ?? ["beta"],
        experiments: { changelogPreview: false, editMessages: true },
        theme: "plugin:monokai:bb-monokai",
      },
    },
  });
  writeJson(join(pluginRoots.alpha, "package.json"), {
    name: "@scope/bb-plugin-alpha",
    scripts: { build: "build", dev: "dev" },
  });
  writeJson(join(pluginRoots.beta, "package.json"), {
    name: "@scope/bb-plugin-beta",
    scripts: { build: "build", dev: "dev" },
  });
  return { root, pluginRoots };
}

class FakeRuntime implements WorkspaceRuntime {
  readonly cwd: string;
  private readonly pluginRoots: { alpha: string; beta: string };
  readonly events: string[] = [];
  readonly states: Record<string, { rootDir: string; enabled: boolean; status: string }>;
  readonly configs: Record<
    string,
    { schema: Record<string, unknown>; values: Record<string, unknown> }
  >;
  readonly experiments: Record<string, boolean> = {
    changelogPreview: false,
    editMessages: false,
  };
  readonly dataDir: string;
  theme = "bb:light";
  bbWrites = 0;
  startOptions: StartOptions | undefined;

  constructor(cwd: string, pluginRoots: { alpha: string; beta: string }) {
    this.cwd = cwd;
    this.pluginRoots = pluginRoots;
    this.dataDir = join(cwd, ".bb-dev", "fixture");
    this.states = {
      alpha: { rootDir: pluginRoots.alpha, enabled: false, status: "running" },
      beta: { rootDir: "/tmp/old-beta", enabled: true, status: "running" },
    };
    this.configs = {
      alpha: { schema: { tidy: { default: true } }, values: { tidy: false } },
      beta: { schema: {}, values: {} },
    };
  }

  resolveName(name?: string): string {
    return name ?? "fixture";
  }

  async start(options: StartOptions = {}): Promise<InstanceResult> {
    this.events.push("start");
    this.startOptions = options;
    return runningResult(options.name ?? "fixture", this.dataDir);
  }

  async run(
    _name: string | undefined,
    argv: readonly [string, ...string[]],
    options: { cwd?: string } = {},
  ): Promise<number> {
    this.events.push(`run:${options.cwd ?? this.cwd}:${argv.join(" ")}`);
    return 0;
  }

  async captureExec(_name: string | undefined, args: readonly string[]): Promise<CapturedCommand> {
    this.events.push(`bb:${args.join(" ")}`);
    if (args[0] === "plugin" && args[1] === "list") return ok({ plugins: entries(this.states) });
    if (args[0] === "plugin" && args[1] === "install") {
      const root = args[2]!;
      const id = root === this.pluginRoots.alpha ? "alpha" : "beta";
      this.states[id] = { rootDir: root, enabled: true, status: "running" };
      this.bbWrites += 1;
      return ok({});
    }
    if (args[0] === "plugin" && args[1] === "enable") {
      this.states[args[2]!]!.enabled = true;
      this.bbWrites += 1;
      return ok({});
    }
    if (args[0] === "plugin" && args[1] === "config" && args.length === 4) {
      return ok(this.configs[args[2]!]!);
    }
    if (args[0] === "plugin" && args[1] === "config" && args[3] === "unset") {
      delete this.configs[args[2]!]!.values[args[4]!];
      this.bbWrites += 1;
      return ok({});
    }
    if (args[0] === "settings" && args[1] === "show") {
      return ok({ dataDir: this.dataDir, experiments: this.experiments });
    }
    if (args[0] === "settings" && args[1] === "experiment") {
      this.experiments[args[2]!] = args[3] === "true";
      this.bbWrites += 1;
      return ok({});
    }
    if (args[0] === "theme" && args[1] === "show") return ok({ themeId: this.theme });
    if (args[0] === "theme" && args[1] === "set") {
      this.theme = args[2]!;
      this.bbWrites += 1;
      return ok({});
    }
    return ok({});
  }
}

function entries(
  states: Record<string, { rootDir: string; enabled: boolean; status: string }>,
): Array<{ id: string; rootDir: string; enabled: boolean; status: string }> {
  return Object.entries(states).map(([id, state]) => ({
    id,
    rootDir: state.rootDir,
    enabled: state.enabled,
    status: state.status,
  }));
}

function ok(value: unknown): CapturedCommand {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}

function runningResult(name: string, dataDir: string): InstanceResult {
  return {
    name,
    phase: "running",
    source: "owned",
    revision: "tag:desktop-v1.2.3",
    commit: "a".repeat(40),
    desiredRuntime: "web",
    checkoutPath: "/tmp/checkout",
    branch: "detached (fixture)",
    node: "fixture node",
    codex: "fixture codex",
    dataDir,
    appUrl: "http://localhost:11001",
    serverUrl: "http://localhost:19001",
    hostDaemonUrl: "http://127.0.0.1:27001",
    desktopUserDataDir: join(dataDir, "desktop"),
    devSession: "running",
    desktopSession: "stopped",
    devLog: "/tmp/dev.log",
    desktopLog: "/tmp/desktop.log",
    launcherLog: "/tmp/launcher.log",
    running: true,
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
