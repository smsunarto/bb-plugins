import { createContext, useContext, type ReactNode } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

const LocalMachineContext = createContext("");

export function MachineAppearanceProvider({
  localMachineId,
  children,
}: {
  localMachineId: unknown;
  children: ReactNode;
}) {
  return (
    <LocalMachineContext.Provider value={typeof localMachineId === "string" ? localMachineId : ""}>
      {children}
    </LocalMachineContext.Provider>
  );
}

export function useRemoteMachine(host: PluginSidebarThread["host"]): boolean {
  const localMachineId = useContext(LocalMachineContext);
  return host !== null && host.id !== localMachineId;
}
