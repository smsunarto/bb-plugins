import { useMemo } from "react";
import {
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { changeHiddenMachines, type MachineVisibilityChange } from "../lib/machine-visibility";
import { machineVisibility, type SidebarMachine } from "../lib/machines";
import { gtdSidebarRpcContract } from "../lib/rpc-contract";
import { useCommittedEvent } from "./use-committed-event";
import { useOrderedWrites } from "./use-ordered-writes";
import { usePaintGate } from "./use-paint-gate";

const MACHINES_READ = {};

/**
 * The saved machine choice, as bb's cached read. A change draws on the click
 * and changes go out one at a time in click order. Commands describe the
 * result they want, so each unanswered one draws over any newer read, another
 * window's change included, and bb's prediction then holds it until a
 * confirmed read lands. Before the first read lands, changes draw over the
 * newest answer a write returned, or over showing every machine. A failed
 * change drops off with a toast.
 */
export function useMachineVisibility(machines: readonly SidebarMachine[]) {
  const { data, isLoading } = useRpcQuery({
    contract: gtdSidebarRpcContract,
    method: "listMachineVisibility",
    input: MACHINES_READ,
  });
  const ready = usePaintGate(isLoading);
  const { mutate } = useRpcMutation({
    contract: gtdSidebarRpcContract,
    method: "changeMachineVisibility",
    optimistic: (command, cache) =>
      cache.update("listMachineVisibility", MACHINES_READ, (current) => ({
        hiddenMachineIds: changeHiddenMachines(current.hiddenMachineIds, command),
      })),
  });
  const writes = useOrderedWrites((command: MachineVisibilityChange) => mutate(command));
  const change = useCommittedEvent((command: MachineVisibilityChange) => {
    writes.write(command).catch(() => {
      toast.error("Couldn’t save visible machines. Please try again.");
    });
  });
  // An answer only matters until the first read lands.
  const base = data?.hiddenMachineIds ?? writes.answer?.hiddenMachineIds;
  const visibility = useMemo(
    () =>
      machineVisibility(
        machines,
        writes.unsettled.reduce<string[]>(changeHiddenMachines, base ?? []),
      ),
    [machines, base, writes.unsettled],
  );
  return { ...visibility, ready, change };
}
