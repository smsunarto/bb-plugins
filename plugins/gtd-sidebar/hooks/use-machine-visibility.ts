import { useCallback, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { gtdSidebarRpcContract } from "../server";
import { changeHiddenMachines, type MachineVisibilityChange } from "../lib/machine-visibility";
import { machineVisibility, type SidebarMachine } from "../lib/machines";
import { useCommittedEvent } from "./use-committed-event";
import { useLifecycleChannelList } from "./use-lifecycle-channel-list";

const MACHINE_REFRESHES = ["machines"] as const;
interface PendingChange {
  id: number;
  change: MachineVisibilityChange;
}

export function useMachineVisibility(machines: readonly SidebarMachine[]) {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const [state, setState] = useState<{ confirmed: string[]; pending: PendingChange[] }>({
    confirmed: [],
    pending: [],
  });
  const writes = useRef({ sent: 0, settled: 0, queue: Promise.resolve() });
  const { ready, refresh } = useLifecycleChannelList(
    useCallback(async () => {
      const { sent, settled } = writes.current;
      const version = sent === settled ? sent : -1;
      const result = await rpc.call("listMachineVisibility", {});
      return { ...result, version };
    }, [rpc]),
    useCallback((result) => {
      const { sent, settled } = writes.current;
      if (result.version !== sent || sent !== settled) return;
      setState({ confirmed: result.hiddenMachineIds, pending: [] });
    }, []),
    MACHINE_REFRESHES,
  );
  const change = useCommittedEvent((command: MachineVisibilityChange) => {
    const id = ++writes.current.sent;
    setState((current) => ({ ...current, pending: [...current.pending, { id, change: command }] }));
    // Keep this window's clicks in order even when a later RPC would travel faster.
    writes.current.queue = writes.current.queue.then(async () => {
      try {
        const result = await rpc.call("changeMachineVisibility", command);
        setState((current) => ({
          confirmed: result.hiddenMachineIds,
          pending: current.pending.filter((pending) => pending.id !== id),
        }));
      } catch {
        setState((current) => ({
          ...current,
          pending: current.pending.filter((pending) => pending.id !== id),
        }));
        toast.error("Couldn’t save visible machines. Please try again.");
      } finally {
        writes.current.settled += 1;
        if (writes.current.sent === writes.current.settled) refresh();
      }
      return undefined;
    });
  });
  const visibility = useMemo(() => {
    const hiddenIds = state.pending.reduce(
      (hidden, pending) => changeHiddenMachines(hidden, pending.change),
      state.confirmed,
    );
    return machineVisibility(machines, hiddenIds);
  }, [machines, state]);
  return { ...visibility, ready, change };
}
