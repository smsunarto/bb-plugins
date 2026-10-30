import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useSdk, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { machineColors, useRosterColors, useBoatMachineIds } from "../../lib/machine-colors";
import type { SidebarMachine } from "../../lib/machines";

/** The machine whose threads go unmarked; null while settings or bb's primary host load. */
const LocalMachineContext = createContext<string | null>("");
/** Machine colors depend only on identity. */
const BoatMachineContext = createContext<ReadonlySet<string>>(new Set());
const MachineColorContext = createContext(machineColors([]));

export function MachineAppearanceProvider({
  localMachineId,
  settingsLoading,
  knownMachines,
  children,
}: {
  localMachineId: unknown;
  settingsLoading: boolean;
  /**
   * bb's machine list triggers provider metadata refreshes when hosts join or leave.
   */
  knownMachines: readonly SidebarMachine[] | undefined;
  children: ReactNode;
}) {
  const setting = typeof localMachineId === "string" ? localMachineId.trim() : "";
  const sdk = useSdk();
  const [primaryHostId, setPrimaryHostId] = useState<string | null>(null);
  // An empty setting means bb's primary host, so a single-machine user sees
  // no globe at all, not even for the frame before the read lands. The SDK
  // client is stable, so this reads once, and again only when the setting is
  // cleared. A failed read marks every machine remote, as the list did before.
  // Until settings load, a saved choice may still name another machine, so
  // no machine is marked yet.
  useEffect(() => {
    if (setting !== "") return;
    const controller = new AbortController();
    void sdk.system.config({ signal: controller.signal }).then(
      (config) => setPrimaryHostId(config.primaryHostId ?? ""),
      () => {
        if (!controller.signal.aborted) setPrimaryHostId("");
      },
    );
    return () => controller.abort();
  }, [sdk, setting]);
  const colorOf = useRosterColors(knownMachines);
  const boatIds = useBoatMachineIds(knownMachines);
  return (
    <LocalMachineContext.Provider value={settingsLoading ? null : setting || primaryHostId}>
      <BoatMachineContext.Provider value={boatIds}>
        <MachineColorContext.Provider value={colorOf}>{children}</MachineColorContext.Provider>
      </BoatMachineContext.Provider>
    </LocalMachineContext.Provider>
  );
}

export function useRemoteMachine(host: PluginSidebarThread["host"]): boolean {
  const localMachineId = useContext(LocalMachineContext);
  return host !== null && localMachineId !== null && host.id !== localMachineId;
}

export function useMachineColors(): (hostId: string) => string {
  return useContext(MachineColorContext);
}

export function useIsBoatMachine(hostId: string | undefined): boolean {
  return useContext(BoatMachineContext).has(hostId ?? "");
}
