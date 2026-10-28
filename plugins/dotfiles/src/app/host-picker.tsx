import type { ReactElement } from "react";
import { toast } from "sonner";
import { queryClient } from "./query.ts";
import { queryKey, useRpcMutation, useRpcQuery } from "./rpc.ts";
import { errorMessage } from "./tasks.ts";

/**
 * The overview of the panel's machine: the stored pick, else the bb server's
 * own. Every read and write names the machine this returns, so a cached file
 * or a draft never crosses to another machine's checkout.
 */
export function usePanelOverview() {
  const hosts = useRpcQuery("hosts");
  // A failed host list leaves the pick to the server rather than stalling.
  const hostId = hosts.data?.selectedHostId ?? undefined;
  return useRpcQuery("overview", { hostId }, { enabled: !hosts.isPending });
}

export function HostPicker(): ReactElement | null {
  const hosts = useRpcQuery("hosts");
  const select = useRpcMutation("selectHost", {
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKey("hosts") }),
    onError: (error) => toast.error(`Switching machine failed: ${errorMessage(error)}`),
  });
  if (hosts.data === undefined) return null;
  const { selectedHostId } = hosts.data;
  return (
    <select
      aria-label="Machine"
      className="max-w-40 shrink-0 cursor-pointer truncate rounded-md border border-border bg-background px-1 py-0.5 text-xs text-foreground"
      value={selectedHostId ?? ""}
      disabled={select.isPending}
      onChange={(event) => select.mutate({ hostId: event.target.value })}
    >
      {selectedHostId === null && <option value="">Choose a machine</option>}
      {hosts.data.hosts.map((host) => (
        <option key={host.id} value={host.id}>
          {host.connected ? host.name : `${host.name} · offline`}
        </option>
      ))}
    </select>
  );
}
