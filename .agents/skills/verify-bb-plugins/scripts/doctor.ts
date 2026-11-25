#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * Read-only health check for a bb-plugins test instance made by
 * scripts/test-instance.ts. Answers "is this instance worth driving?".
 *
 *   .agents/skills/verify-bb-plugins/scripts/doctor.ts [--name <instance>] [--plugin <id>]...
 *
 * The instance defaults to BB_THREAD_ID, as test-instance.ts does. Each
 * --plugin is a plugin under test: it must be enabled, running, loaded from the
 * instance's source copy, that copy must match the checkout, and its app build
 * must be newer than the copy (a failed sync copies source without reloading).
 * Without --plugin, every plugin loaded from the source copy must be running,
 * and freshness is not checked.
 *
 * It talks to the test server only through the instance's `bb` wrapper and
 * writes nothing. Exit code 0 means every check passed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

type State = {
  name: string;
  serverPort: number;
  pid: number | null;
  expiresAt: string | null;
  version: string;
  checkout: string;
};
type Plugin = { id: string; enabled: boolean; status: string; rootDir: string; source: string };

const argv = process.argv.slice(2);
let name = process.env.BB_THREAD_ID ?? "";
const targets: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--name") name = argv[++i] ?? "";
  else if (argv[i] === "--plugin") targets.push(argv[++i] ?? "");
  else {
    console.error(`unknown argument ${argv[i]}`);
    console.error("usage: doctor.ts [--name <instance>] [--plugin <id>]...");
    process.exit(2);
  }
}
if (!/^[\w-]+$/.test(name)) {
  console.error("pass --name <instance> when BB_THREAD_ID is not set");
  process.exit(2);
}

const root = process.env.BB_TEST_INSTANCE_ROOT ?? join(homedir(), ".bb-test", "instances");
const dir = join(root, name);
const data = join(dir, "data");
const src = join(dir, "src");
const wrapper = join(dir, "bb");
let failed = 0;
const ok = (message: string) => console.log(`ok    ${message}`);
const fail = (message: string, fix: string) => {
  failed++;
  console.log(`FAIL  ${message}\n      fix: ${fix}`);
};
const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const testBb = <T>(args: string[]): T | null => {
  const result = run(wrapper, args);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return result.stdout.trim() as T;
  }
};

/** The most recently modified source file of a plugin, outside build output and dependencies. */
function newestSource(pluginDir: string): { path: string; mtimeMs: number } | null {
  let newest: { path: string; mtimeMs: number } | null = null;
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (["dist", "node_modules", "test"].includes(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(tsx?|css|json)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        const { mtimeMs } = statSync(path);
        if (!newest || mtimeMs > newest.mtimeMs)
          newest = { path: relative(pluginDir, path), mtimeMs };
      }
    }
  };
  walk(pluginDir);
  return newest;
}

const statePath = join(dir, "state.json");
if (!existsSync(statePath) || !existsSync(wrapper)) {
  fail(`no test instance ${name} under ${root}`, "bun scripts/test-instance.ts up");
  process.exit(1);
}
const state = JSON.parse(readFileSync(statePath, "utf8")) as State;

const pidArgs = state.pid ? run("ps", ["-o", "args=", "-p", String(state.pid)]).stdout : "";
if (pidArgs.includes(data)) ok(`process ${state.pid} serves ${data}`);
else fail(`instance ${name} is not running`, "bun scripts/test-instance.ts up");

const url = `http://127.0.0.1:${state.serverPort}`;
const answered = await fetch(url, { signal: AbortSignal.timeout(3000) }).then(
  (response) => response.ok,
  () => false,
);
if (answered) ok(`server answers at ${url} (stops ${state.expiresAt})`);
else fail(`server at ${url} does not answer`, "bun scripts/test-instance.ts up");
if (failed) process.exit(1);

const settings = testBb<{ dataDir: string; appearance?: { themeId?: string } }>([
  "settings",
  "show",
  "--json",
]);
if (settings && resolve(settings.dataDir) === resolve(data)) ok("wrapper routes to this instance");
else
  fail(
    `wrapper ${wrapper} does not reach this instance's data dir`,
    "bun scripts/test-instance.ts up",
  );

const version = testBb<string>(["--version"]);
if (version === state.version) ok(`bb ${version}`);
else
  fail(`bb ${version} differs from recorded ${state.version}`, "bun scripts/test-instance.ts up");

const theme = settings?.appearance?.themeId;
if (theme === "plugin:monokai:bb-monokai") ok("theme bb Monokai");
else fail(`theme is ${theme ?? "unset"}`, `${wrapper} theme set plugin:monokai:bb-monokai`);

const plugins = testBb<{ plugins: Plugin[] }>(["plugin", "list", "--json"])?.plugins ?? [];
const fromSource = (plugin: Plugin) => resolve(plugin.rootDir).startsWith(resolve(src) + sep);
const checked = targets.length
  ? targets.map((id) => plugins.find((plugin) => plugin.id === id) ?? ({ id } as Plugin))
  : plugins.filter((plugin) => plugin.enabled && fromSource(plugin));
for (const plugin of checked) {
  if (!plugin.rootDir) {
    fail(`plugin ${plugin.id} is not installed`, "bun scripts/test-instance.ts sync");
    continue;
  }
  if (!fromSource(plugin)) {
    fail(`plugin ${plugin.id} loads from ${plugin.rootDir}`, "bun scripts/test-instance.ts sync");
    continue;
  }
  if (!plugin.enabled || plugin.status !== "running") {
    fail(
      `plugin ${plugin.id} is ${plugin.enabled ? plugin.status : "disabled"}`,
      `${wrapper} plugin logs ${plugin.id}; the sync exceptions say why a plugin stays disabled`,
    );
    continue;
  }
  if (targets.length) {
    // Same filters as test-instance.ts syncSource, scoped to one plugin, dry run.
    const diff = run("rsync", [
      "-anc",
      "--delete",
      "--itemize-changes",
      "--exclude=/dist/",
      "--exclude=node_modules/",
      "--exclude=*.tsbuildinfo",
      `${join(state.checkout, "plugins", plugin.id)}/`,
      `${join(src, "plugins", plugin.id)}/`,
    ]);
    // Content changes only, as test-instance.ts changedPaths reads them: a
    // leading "." is an attribute-only difference such as a copied mtime.
    const stale = diff.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) => line && (line.startsWith("*deleting") || (line[0] !== "." && line[1] !== "d")),
      );
    if (!diff.ok)
      fail(`could not compare ${plugin.id} source: ${diff.stderr.trim()}`, "check rsync");
    else if (stale.length) {
      fail(
        `plugin ${plugin.id} source copy is stale (${stale.length} path(s), e.g. ${stale[0]!.split(/\s+/).pop()})`,
        "bun scripts/test-instance.ts sync",
      );
      continue;
    }
    // sync copies source before it reloads; a sync that fails part way leaves
    // the copy current and the running build old.
    const bundle = join(plugin.rootDir, "dist", "app.js");
    if (existsSync(bundle)) {
      const built = statSync(bundle).mtimeMs;
      const newer = newestSource(plugin.rootDir);
      if (newer && newer.mtimeMs > built) {
        fail(
          `plugin ${plugin.id} build predates its source copy (${newer.path})`,
          `${wrapper} plugin reload ${plugin.id}`,
        );
        continue;
      }
    }
  }
  ok(
    `plugin ${plugin.id} running from the source copy${targets.length ? ", matches checkout and build" : ""}`,
  );
}

console.log(failed ? `\n${failed} check(s) failed` : `\nhealthy: ${url}  cli ${wrapper}`);
process.exit(failed ? 1 : 0);
