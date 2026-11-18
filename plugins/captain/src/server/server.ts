import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCheck } from "./check.ts";
import { captainCli } from "./cli.ts";
import { ensureStorageRoot, type CommandDeps } from "./commands/deps.ts";
import { configure } from "./configure.ts";
import { createDrive } from "./drive.ts";
import { createFields } from "./fields.ts";
import { createRegistry } from "./registry.ts";
import { registerRpc } from "./rpc.ts";
import { openStore } from "./store.ts";
import { createTasksClient } from "./tasks-client.ts";

export type StartOptions = {
  captainsDir?: string;
  now?: () => number;
  /** How long a Tasks call may take; tests shorten it. */
  tasksDeadlineMs?: number;
  /** How often a watched banner rechecks the crew; tests shorten it. */
  crewPollMs?: number;
};

/** Wires the plugin; holds no logic of its own. Returns the parts tests drive. */
export async function start(bb: BbPluginApi, options: StartOptions = {}) {
  const store = openStore(bb);
  const registry = createRegistry(store);
  const drive = createDrive();
  const files = instructionFiles(import.meta.url);
  const tasks = createTasksClient(bb, options.tasksDeadlineMs);
  const fields = createFields(tasks);
  const deps: CommandDeps = {
    bb,
    registry,
    store,
    drive,
    tasks,
    fields,
    files,
    now: options.now ?? Date.now,
    captainsDir: options.captainsDir ?? join(homedir(), CAPTAINS_FOLDER),
    wakeCheck: () => check.poke(),
  };
  const check = createCheck(deps);

  bb.agents.configure((context) => {
    try {
      return configure(context, { registry, store, drive, files });
    } catch (error) {
      bb.log.warn(`configure failed for ${context.thread.id}: ${(error as Error).message}`);
      return { tools: [], skills: [] };
    }
  });
  bb.cli.register(captainCli(deps));
  registerRpc(deps, options.crewPollMs);
  check.register(bb);

  // `configure` is synchronous, so the Drive root is read once here and cached.
  const ready = ensureStorageRoot(deps).then(
    () => undefined,
    (error: unknown) =>
      bb.log.warn(`thread-storage root not read yet: ${(error as Error).message}`),
  );
  // Tasks may load after Captain: a failure here is retried by the next `verdict`.
  const fieldsReady = fields.ensure().then(
    () => undefined,
    (error: unknown) => bb.log.warn(`verdict fields not defined yet: ${(error as Error).message}`),
  );
  return { store, registry, drive, check, ready, fieldsReady };
}

const CAPTAINS_FOLDER = "Captains";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  await start(bb);
}
