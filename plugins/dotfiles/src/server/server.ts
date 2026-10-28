import {
  defineCli,
  defineRpcContract,
  PluginCliError,
  type BbPluginApi,
  type PluginCliCommand,
} from "@get-bb/plugin-sdk";
import type { SentryPluginReporter } from "@bb-plugins/sentry/node";
import type { SentryPerformanceReporter } from "@bb-plugins/sentry/performance";
import { sentryPluginTelemetry } from "@bb-plugins/sentry/telemetry";
import { cat } from "./command/cat.ts";
import { check } from "./command/check.ts";
import { list } from "./command/list.ts";
import { render } from "./command/render.ts";
import { status } from "./command/status.ts";
import { sync } from "./command/sync.ts";
import { hosts, hostsContract } from "./rpc/hosts.ts";
import { overview, overviewContract } from "./rpc/overview.ts";
import { publish, publishContract } from "./rpc/publish.ts";
import { readFile, readFileContract } from "./rpc/read-file.ts";
import { removeSkill, removeSkillContract } from "./rpc/remove-skill.ts";
import { runTask, runTaskContract } from "./rpc/run-task.ts";
import { saveFile, saveFileContract } from "./rpc/save-file.ts";
import { selectHost, selectHostContract } from "./rpc/select-host.ts";
import { createDotfilesGit, type GitContext } from "./git.ts";
import { PLUGIN_TELEMETRY } from "../shared/telemetry.ts";

const telemetry = sentryPluginTelemetry({
  ...PLUGIN_TELEMETRY,
  serverEntryUrl: import.meta.url,
});

export const contract = defineRpcContract({
  hosts: hostsContract,
  overview: overviewContract,
  publish: publishContract,
  readFile: readFileContract,
  removeSkill: removeSkillContract,
  runTask: runTaskContract,
  saveFile: saveFileContract,
  selectHost: selectHostContract,
});

/** Sentry reporters; each is undefined when telemetry is off. */
interface Reporters {
  readonly errors: SentryPluginReporter | undefined;
  readonly performance: SentryPerformanceReporter | undefined;
}

const REPORTER_DISPOSE_TIMEOUT_MS = 2_000;

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const reporters = createReporters(bb);
  const startup = reporters.performance?.start({ operation: "plugin.startup" });
  try {
    registerPlugin(bb, reporters);
    startup?.finish("ok");
  } catch (error) {
    startup?.finish("error");
    reporters.errors?.capture({ boundary: "plugin.factory", error });
    await disposeReporters(reporters);
    throw error;
  }
}

function registerPlugin(bb: BbPluginApi, reporters: Reporters): void {
  const ctx: GitContext = Object.freeze({ bb, git: createDotfilesGit(bb) });
  const rpc = <T>(method: keyof typeof contract, run: () => Promise<T>) =>
    observe(reporters, "rpc.execute", method, run, rpcTraceOperation(method));
  bb.rpc.register(contract, {
    hosts: () => rpc("hosts", () => hosts(ctx)),
    overview: (input) => rpc("overview", () => overview(ctx, input)),
    publish: (input) => rpc("publish", () => publish(ctx, input)),
    readFile: (input) => rpc("readFile", () => readFile(ctx, input)),
    removeSkill: (input) => rpc("removeSkill", () => removeSkill(ctx, input)),
    runTask: (input) => rpc("runTask", () => runTask(ctx, input)),
    saveFile: (input) => rpc("saveFile", () => saveFile(ctx, input)),
    selectHost: (input) => rpc("selectHost", () => selectHost(ctx, input)),
  });
  const commands = { cat, check, list, render, status, sync };
  bb.cli.register(
    defineCli({
      name: "dotfiles",
      summary: "CLI for the dotfiles plugin",
      commands: Object.fromEntries(
        Object.entries(commands).map(([name, command]) => [
          name,
          observedCommand(reporters, name, command(ctx)),
        ]),
      ),
    }),
  );
}

function createReporters(bb: BbPluginApi): Reporters {
  const scope = { pluginId: PLUGIN_TELEMETRY.pluginId, host: bb };
  const reporters: Reporters = {
    errors: telemetry.errorReporter(scope),
    performance: telemetry.performanceReporter(scope),
  };
  if (reporters.errors === undefined && reporters.performance === undefined) return reporters;
  try {
    bb.onDispose(() => disposeReporters(reporters));
    return reporters;
  } catch {
    void disposeReporters(reporters);
    return { errors: undefined, performance: undefined };
  }
}

async function disposeReporters({ errors, performance }: Reporters): Promise<void> {
  await Promise.all([
    errors?.dispose(REPORTER_DISPOSE_TIMEOUT_MS),
    performance?.dispose(REPORTER_DISPOSE_TIMEOUT_MS),
  ]);
}

/** RPC keys are camelCase; telemetry identifiers are lowercase kebab. */
function rpcTraceOperation(method: string): string {
  return `rpc.${method.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** A command whose unexpected failures reach Sentry; its own `PluginCliError`s and aborts do not. */
function observedCommand(reporters: Reporters, name: string, command: PluginCliCommand) {
  return {
    ...command,
    run: (
      input: Parameters<PluginCliCommand["run"]>[0],
      cli: Parameters<PluginCliCommand["run"]>[1],
    ) =>
      observe(
        reporters,
        "command.execute",
        name,
        async () => command.run(input, cli),
        undefined,
        (error) =>
          error instanceof PluginCliError ||
          (cli.signal?.aborted === true && error instanceof Error && error.name === "AbortError"),
      ),
  };
}

/** Run one handler: trace it when `traceOperation` is set, and report a failure that is not `expected`. */
async function observe<T>(
  reporters: Reporters,
  boundary: "rpc.execute" | "command.execute",
  operation: string,
  run: () => Promise<T>,
  traceOperation?: string,
  expected: (error: unknown) => boolean = () => false,
): Promise<T> {
  const trace =
    traceOperation === undefined
      ? undefined
      : reporters.performance?.start({ operation: traceOperation });
  try {
    const result = await run();
    trace?.finish("ok");
    return result;
  } catch (error) {
    trace?.finish("error");
    if (!expected(error)) reporters.errors?.capture({ boundary, operation, error });
    throw error;
  }
}
