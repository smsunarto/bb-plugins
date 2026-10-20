import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { changeHiddenMachines, type MachineVisibilityChange } from "./machine-visibility.ts";

const machineId = z.string().min(1);
export const machineVisibilityChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({
    kind: z.literal("set"),
    machineId,
    visible: z.boolean(),
    machineIds: z.array(machineId).min(1),
  }),
  z.object({ kind: z.literal("only"), machineId, machineIds: z.array(machineId).min(1) }),
]) satisfies z.ZodType<MachineVisibilityChange>;
const hiddenIdsSchema = z.array(machineId);
const STORAGE_KEY = "hiddenMachineIds";

export function createMachineVisibilityStore(
  kv: BbPluginApi["storage"]["kv"],
  onChange: () => void,
) {
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
          onChange();
        }
        return next;
      });
      queue = result.catch(() => {});
      return result;
    },
  };
}
