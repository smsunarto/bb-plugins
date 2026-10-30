import { createContext, useContext, type ReactNode } from "react";
import {
  experimental_Icon as Icon,
  experimental_useSidebarThreads as useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { machineColors, useRosterColors, useBoatMachineIds } from "./machine-colors.ts";

const BoatMachineContext = createContext<ReadonlySet<string>>(new Set());
const MachineColorContext = createContext(machineColors([]));

/** Resolves Boat provider identity once per panel and refreshes as machines join or leave. */
export function MachineColorProvider({ children }: { children: ReactNode }) {
  const hosts = useSidebarThreads().experimental_hosts;
  const colorOf = useRosterColors(hosts);
  const boatIds = useBoatMachineIds(hosts);
  return (
    <BoatMachineContext.Provider value={boatIds}>
      <MachineColorContext.Provider value={colorOf}>{children}</MachineColorContext.Provider>
    </BoatMachineContext.Provider>
  );
}

/** Checkout and machine share a row; the full path stays available in the tooltip. */
export function CheckoutLabel({
  path,
  machine,
  hostId,
}: {
  path: string;
  machine: string;
  hostId: string;
}) {
  const name = path.split(/[\\/]/).findLast(Boolean) ?? path;
  const isBoat = useContext(BoatMachineContext).has(hostId);
  const color = useContext(MachineColorContext)(hostId);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={path} translate="no">
        {name}
      </span>
      <span
        className="flex min-w-0 max-w-[40%] shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground"
        title={`${machine} · ${path}`}
      >
        <span
          className="inline-flex shrink-0 items-center"
          style={{ color: isBoat ? "var(--muted-foreground)" : color }}
          data-machine-id={hostId}
          aria-hidden="true"
        >
          <Icon name={isBoat ? "Bot" : "Globe"} className="size-3" aria-hidden />
        </span>
        <span className="min-w-0 truncate" title={machine}>
          {machine}
        </span>
      </span>
      <span className="sr-only" translate="no">
        {path}
      </span>
    </span>
  );
}
