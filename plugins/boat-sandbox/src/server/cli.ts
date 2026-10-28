import {
  cliCommand,
  defineCli,
  PluginCliError,
  type BbPluginApi,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import type { ConnectionStatus, LaunchOptions, MachineInspection } from "../shared/schema.ts";
import { errorMessage } from "./lib/error-message.ts";

export interface BoatCliHandlers {
  accountInspect(): Promise<ConnectionStatus>;
  machineInspect(hostId: string): Promise<MachineInspection>;
  launchOptions(): Promise<LaunchOptions>;
}

const jsonOption = {
  json: {
    type: "boolean",
    description: "Emit the raw result as JSON instead of readable text",
  },
} as const;

async function guarded(run: () => Promise<PluginCliResult>): Promise<PluginCliResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    throw new PluginCliError(errorMessage(error));
  }
}

function describeOptions(options: LaunchOptions): string {
  const types = options.types
    .map(
      (entry) =>
        `${entry.type}${entry.type === options.defaultType ? " (default)" : ""}${
          entry.available ? "" : ` — unavailable: ${entry.reason ?? "blocked"}`
        }`,
    )
    .join("\n");
  const snapshots = options.snapshots.length === 0 ? "(none)" : options.snapshots.join("\n");
  return `Sizes:\n${types}\n\nSaved snapshots:\n${snapshots}`;
}

export function registerCli(bb: BbPluginApi, handlers: BoatCliHandlers): void {
  bb.cli.register(
    defineCli({
      name: "boat",
      summary: "Inspect the Boat account and Boat machines",
      commands: {
        "account inspect": cliCommand({
          summary: "Test the configured Boat API key without allocating a sandbox",
          options: jsonOption,
          run(input) {
            return guarded(async () => {
              const result = await handlers.accountInspect();
              return {
                exitCode: result.available ? 0 : 1,
                stdout: input.options.json ? JSON.stringify(result) : result.message,
              };
            });
          },
        }),
        "machine inspect": cliCommand({
          summary: "Show Boat's state for a machine: phase, auto-stop deadline, disk expiry",
          positionals: [
            {
              name: "host-id",
              description: "BB host whose Boat sandbox is inspected",
              required: true,
            },
          ],
          options: jsonOption,
          run(input) {
            return guarded(async () => {
              const result = await handlers.machineInspect(input.positionals["host-id"]);
              return {
                exitCode: 0,
                stdout: input.options.json ? JSON.stringify(result) : result.summary,
              };
            });
          },
        }),
        "launch options": cliCommand({
          summary: "List the sandbox sizes and saved snapshots a new machine can use",
          options: jsonOption,
          run(input) {
            return guarded(async () => {
              const result = await handlers.launchOptions();
              return {
                exitCode: 0,
                stdout: input.options.json ? JSON.stringify(result) : describeOptions(result),
              };
            });
          },
        }),
      },
    }),
  );
}
