import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { changeHiddenMachines, type MachineVisibilityChange } from "./machine-visibility.ts";

const hiddenIdsSchema = z.array(z.string().min(1));
const STORAGE_KEY = "hiddenMachineIds";

/** Changes run one at a time; the RPC contract invalidates every window's read. */
export function createMachineVisibilityStore(kv: BbPluginApi["storage"]["kv"]) {
  // A value an older build or a hand edit left behind hides nothing.
  const read = async () => {
    const saved = hiddenIdsSchema.safeParse(await kv.get(STORAGE_KEY));
    return saved.success ? saved.data : [];
  };
  let queue: Promise<unknown> = Promise.resolve();
  return {
    read,
    change(change: MachineVisibilityChange): Promise<string[]> {
      const result = queue.then(async () => {
        const current = await read();
        const next = changeHiddenMachines(current, change);
        if (current.length !== next.length || current.some((id) => !next.includes(id))) {
          await kv.set(STORAGE_KEY, next);
        }
        return next;
      });
      queue = result.catch(() => {});
      return result;
    },
  };
}
