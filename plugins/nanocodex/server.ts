/**
 * Registers nanocodex as a bb provider.
 *
 * Declaration only. The executable implementation is this plugin's own
 * provider bridge — the `experimental_providerBridge` export of the `bb.host`
 * artifact — which spawns `nanocodex run` per turn. No launch spec, no
 * separate bridge process.
 *
 * Registration happens inside `bb.background.service("register", ...)`: bb
 * starts one after the factory resolves, when `bb.sdk` is bound, and a service
 * that returns without throwing simply stops. The one prerequisite this cannot
 * supply — the nanocodex CLI — becomes `bb.status.needsConfiguration` rather
 * than a load failure, so the plugin stays installed and says what is missing.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildNanocodexProviderDeclaration, type NanocodexSettings } from "./lib/declaration.ts";
import { readNanocodexVersion, resolveNanocodexCli } from "./lib/provision.ts";
import { DEFAULT_HISTORY_BUDGET_BYTES, NANOCODEX_PROVIDER_ID } from "./src/catalog.ts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Where the bridge bundle sits relative to whichever module bb loaded: a path
 * source runs `server.ts` from the plugin root, a managed install runs the
 * prebuilt `dist/server.js`. Diagnostics only; registration does not gate on
 * it, because a path-source dev flow may build it later.
 */
const HOST_BUNDLE = existsSync(join(MODULE_DIR, "host.js"))
  ? join(MODULE_DIR, "host.js")
  : join(MODULE_DIR, "dist", "host.js");

const NANOCODEX_CLI_HINT =
  "Install nanocodex (https://github.com/gakonst/nanocodex), set NANOCODEX_CLI_PATH " +
  "if it is off PATH, then run `bb plugin reload nanocodex`.";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  // The settings descriptor union has no "number" type, so the budget is a
  // string field parsed on read; a non-numeric value falls back to the
  // default via `historyBudgetKb * 1024 || DEFAULT_HISTORY_BUDGET_BYTES`.
  const settingsHandle = bb.settings.define({
    historyBudgetKb: {
      type: "string",
      label: "History budget (KB)",
      description:
        "How much earlier conversation to re-send with each turn, in KB of rendered text. " +
        "Every nanocodex run starts a fresh session, so bb replays the thread as part of " +
        "the prompt. Larger keeps more memory and costs more input tokens per turn. " +
        `Default ${String(DEFAULT_HISTORY_BUDGET_BYTES / 1024)}.`,
      default: String(DEFAULT_HISTORY_BUDGET_BYTES / 1024),
    },
    subagents: {
      type: "boolean",
      label: "Subagents",
      description: "Allow nanocodex to launch subagents (--subagents). The CLI's own default is on.",
      default: true,
    },
    webSearch: {
      type: "boolean",
      label: "Web search",
      description: "Allow web search (--web-search). The CLI's own default is on.",
      default: true,
    },
    imageGeneration: {
      type: "boolean",
      label: "Image generation",
      description: "Allow image generation (--image-generation). The CLI's own default is on.",
      default: true,
    },
    mcpDefaults: {
      type: "boolean",
      label: "Built-in MCP servers",
      description:
        "Attach nanocodex's five built-in docs MCP servers (--mcp-defaults). Surfaced " +
        "because the CLI attaches them silently by default.",
      default: true,
    },
  });

  type RawSettings = Awaited<ReturnType<typeof settingsHandle.get>>;
  function toSettings(raw: RawSettings): NanocodexSettings {
    return {
      historyBudgetKb: Number(raw.historyBudgetKb),
      subagents: raw.subagents,
      webSearch: raw.webSearch,
      imageGeneration: raw.imageGeneration,
      mcpDefaults: raw.mcpDefaults,
    };
  }

  /** CLI path the registration resolved; `bb nanocodex status` reuses it. */
  let nanocodexCliPath: string | null = null;

  bb.background.service("register", {
    async start() {
      const cli = resolveNanocodexCli(process.env);
      if (cli === null) {
        bb.status.needsConfiguration(`The nanocodex CLI was not found. ${NANOCODEX_CLI_HINT}`);
        return;
      }
      nanocodexCliPath = cli;
      // `deriveProviderOptions` is synchronous and sits on the turn-submit
      // path, but the settings handle only reads asynchronously — so the
      // current values are cached here and refreshed on change.
      let current = toSettings(await settingsHandle.get());
      settingsHandle.onChange((next) => {
        current = toSettings(next);
      });
      try {
        bb.providers.register(
          buildNanocodexProviderDeclaration({ nanocodexCliPath: cli }, () => current),
        );
      } catch (error) {
        bb.log.error(`Could not register the nanocodex provider: ${String(error)}`);
        bb.status.needsConfiguration(
          `Could not register the nanocodex provider: ${String(error)}. Fix the problem, then run \`bb plugin reload nanocodex\`.`,
        );
      }
    },
  });

  function authLine(cli: string): string {
    const probe = spawnSync(cli, ["auth", "status"], { encoding: "utf8", timeout: 10_000 });
    if (probe.error !== undefined) return `auth: unknown (${probe.error.message})`;
    if (probe.status === 0) {
      const detail = (probe.stdout ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join("; ");
      return `auth: signed in${detail.length > 0 ? ` (${detail})` : ""}`;
    }
    return "auth: NOT signed in — nanocodex shares ~/.codex/auth.json with Codex, so `codex login` also signs it in";
  }

  async function statusLines(): Promise<string[]> {
    const cli = nanocodexCliPath ?? resolveNanocodexCli(process.env);
    const lines = [
      cli === null
        ? `nanocodex CLI: NOT FOUND. ${NANOCODEX_CLI_HINT}`
        : `nanocodex CLI: ${cli} (${readNanocodexVersion(cli) ?? "version unknown"})`,
      `bridge bundle: ${existsSync(HOST_BUNDLE) ? HOST_BUNDLE : `MISSING (${HOST_BUNDLE}); run \`bb plugin build\` in the plugin directory`}`,
    ];
    try {
      const providers = await bb.sdk.providers.list();
      const registered = providers.some((provider) => provider.id === NANOCODEX_PROVIDER_ID);
      lines.push(`bb provider ${NANOCODEX_PROVIDER_ID}: ${registered ? "registered" : "NOT registered"}`);
    } catch (error) {
      lines.push(`bb provider ${NANOCODEX_PROVIDER_ID}: unknown (${String(error)})`);
    }
    lines.push(cli === null ? "auth: unknown (no CLI)" : authLine(cli));
    return lines;
  }

  bb.cli.register({
    name: "nanocodex",
    summary: "Inspect the nanocodex provider integration.",
    commands: [
      {
        name: "status",
        summary: "Check the nanocodex CLI, the bridge bundle, registration, and auth",
        usage: "nanocodex status",
      },
    ],
    async run(argv) {
      const command = argv[0] ?? "status";
      if (command === "status") {
        return { exitCode: 0, stdout: `${(await statusLines()).join("\n")}\n` };
      }
      return { exitCode: 2, stderr: `Unknown subcommand "${command}". Use "bb nanocodex status".\n` };
    },
  });
}
