import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useSdk, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";

/** The machine whose threads go unmarked; null while settings or bb's primary host load. */
const LocalMachineContext = createContext<string | null>("");

export function MachineAppearanceProvider({
  localMachineId,
  settingsLoading,
  children,
}: {
  localMachineId: unknown;
  settingsLoading: boolean;
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
  return (
    <LocalMachineContext.Provider value={settingsLoading ? null : setting || primaryHostId}>
      {children}
    </LocalMachineContext.Provider>
  );
}

export function useRemoteMachine(host: PluginSidebarThread["host"]): boolean {
  const localMachineId = useContext(LocalMachineContext);
  return host !== null && localMachineId !== null && host.id !== localMachineId;
}
