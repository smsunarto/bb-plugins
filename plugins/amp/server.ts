// Registers Amp as a custom ACP provider in bb via the plugin's own bundled
// ACP bridge (dist/bridge.js), which drives the Amp CLI through the official
// @ampcode/sdk. No third-party adapter required.
import type { BbPluginApi } from "@bb/plugin-sdk";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectInstallation,
  provisionInstallation,
  resolveAmpCli,
  resolveNodeRuntime,
  PROVIDER_ID,
  type ProvisionPaths,
} from "./lib/provision.js";

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = join(PLUGIN_DIR, "dist", "bridge.js");

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  async function resolveDataDir(): Promise<string> {
    try {
      const config = await bb.sdk.system.config();
      if (config.dataDir.length > 0) return config.dataDir;
    } catch (error) {
      bb.log.warn(`Could not read bb data directory from SDK: ${String(error)}`);
    }
    return process.env.BB_DATA_DIR ?? join(homedir(), ".bb");
  }

  async function paths(): Promise<ProvisionPaths> {
    const dataDir = await resolveDataDir();
    return {
      dataDir,
      configPath: join(dataDir, "config.json"),
      logoPath: join(dataDir, "logos", "amp.svg"),
    };
  }

  async function reloadConfig(): Promise<boolean> {
    try {
      await bb.sdk.system.reloadConfig();
      return true;
    } catch (error) {
      bb.log.warn(`Could not reload bb config: ${String(error)}`);
      return false;
    }
  }

  async function statusLines(): Promise<string[]> {
    const resolvedPaths = await paths();
    const installation = inspectInstallation(resolvedPaths);
    const amp = resolveAmpCli(process.env);
    const lines = [
      `Amp CLI: ${amp ?? "NOT FOUND"}`,
      `bridge bundle: ${existsSync(BRIDGE_PATH) ? BRIDGE_PATH : `MISSING (${BRIDGE_PATH}); run npm install && npm run build in ${PLUGIN_DIR}`}`,
      `node runtime: ${process.execPath}${resolveNodeRuntime(process.execPath).electron ? " (Electron; entry sets ELECTRON_RUN_AS_NODE=1)" : ""}`,
      `config entry: ${installation.configured ? "present" : "missing"}`,
      `logo: ${existsSync(resolvedPaths.logoPath) ? "present" : "missing"}`,
    ];
    try {
      const providers = await bb.sdk.providers.list();
      lines.push(
        `bb provider ${PROVIDER_ID}: ${providers.some((provider) => provider.id === PROVIDER_ID) ? "registered" : "NOT registered"}`,
      );
    } catch (error) {
      lines.push(`bb provider ${PROVIDER_ID}: unknown (${String(error)})`);
    }
    lines.push(
      "auth: handled by the Amp CLI — run `amp login` once, or set AMP_API_KEY in the entry env",
    );
    if (installation.error) lines.push(`config error: ${installation.error}`);
    return lines;
  }

  bb.cli.register({
    name: "amp",
    summary: "Install and inspect the Amp ACP provider integration.",
    commands: [
      {
        name: "setup",
        summary: "Register Amp as a bb provider and reload bb config",
        usage: "amp setup",
      },
      {
        name: "status",
        summary: "Check the Amp CLI, bridge bundle, bb config, assets, and provider registration",
        usage: "amp status",
      },
    ],
    async run(argv) {
      const command = argv[0] ?? "setup";
      if (command === "status") {
        return { exitCode: 0, stdout: `${(await statusLines()).join("\n")}\n` };
      }
      if (command !== "setup") {
        return {
          exitCode: 2,
          stderr: `Unknown subcommand "${command}". Use "bb amp setup" or "bb amp status".\n`,
        };
      }

      if (!existsSync(BRIDGE_PATH)) {
        return {
          exitCode: 1,
          stderr:
            `The bridge bundle is missing at ${BRIDGE_PATH}. `
            + `Run \`npm install && npm run build\` in ${PLUGIN_DIR}, then run \`bb amp setup\` again.\n`,
        };
      }
      const amp = resolveAmpCli(process.env);
      if (!amp) {
        return {
          exitCode: 1,
          stderr:
            "The Amp CLI was not found. Install it from https://ampcode.com/manual#get-started, run `amp login`, then run `bb amp setup` again.\n",
        };
      }
      try {
        const runtime = resolveNodeRuntime(process.execPath);
        const result = provisionInstallation(await paths(), {
          node: runtime.node,
          electron: runtime.electron,
          bridge: BRIDGE_PATH,
          amp,
        });
        const messages = [...result.messages];
        if (result.changed) {
          const reloaded = await reloadConfig();
          messages.push(
            reloaded
              ? "reloaded running bb server config"
              : "WARNING: config was written but the server reload failed; restart bb and check status",
          );
        } else {
          messages.push("configuration is already up to date");
        }
        messages.push(
          "Amp authentication is handled by the Amp CLI; run `amp login` once if needed, or set AMP_API_KEY.",
        );
        return { exitCode: 0, stdout: `${messages.join("\n")}\n` };
      } catch (error) {
        bb.log.error(`Amp setup failed: ${String(error)}`);
        return { exitCode: 1, stderr: `Amp setup failed: ${String(error)}\n` };
      }
    },
  });
}
