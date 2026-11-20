import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { InstructionFiles } from "@bb-plugins/instructions";
import type { Drive } from "../drive.ts";
import type { Fields } from "../fields.ts";
import type { Registry } from "../registry.ts";
import type { Routines } from "../routines.ts";
import type { TaskGuard } from "../spawn.ts";
import type { Store } from "../store.ts";
import type { TasksClient } from "../tasks-client.ts";

export type CommandDeps = {
  bb: BbPluginApi;
  registry: Registry;
  store: Store;
  drive: Drive;
  tasks: TasksClient;
  /** Captain's owned verdict fields in Tasks, defined once a call succeeds. */
  fields: Fields;
  files: InstructionFiles;
  now: () => number;
  /** The shared Captains project's folder on the server's machine. */
  captainsDir: string;
  /** Run the background check soon, such as after a failed answer send; never waits for it. */
  wakeCheck: () => void;
  /** Serializes starts on one task across `dispatch` and the rate-limit fallback. */
  taskGuard: TaskGuard;
  /** Scheduled messages to a Captain, scheduled by bb Automations. */
  routines: Routines;
};

export const JSON_OPTION = {
  type: "boolean",
  description: "Print one compact JSON object",
} as const;

export const CAPTAIN_OPTION = {
  type: "string",
  placeholder: "thread-id-or-name",
  description: "The Captain to act for; defaults to the calling thread",
} as const;

/** Read the server machine's thread-storage root once it is known; refuse while it is not. */
export async function ensureStorageRoot(deps: CommandDeps): Promise<string | null> {
  const cached = deps.registry.storageRoot();
  if (cached !== null) return cached;
  const { primaryHostId } = await deps.bb.sdk.system.config();
  if (primaryHostId === null) return null;
  const root = (await deps.bb.sdk.hosts.get({ hostId: primaryHostId })).threadStorageRootPath;
  deps.registry.setStorageRoot(root);
  return root;
}
