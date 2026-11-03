// GTD's two filters, the project scope and the machines shown, in bb's
// Filter menu page. The list provides them; every header menu reads them.
import { createContext, useContext } from "react";
import { useSetAtom } from "jotai";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { MachineVisibilityChange } from "../../lib/machine-visibility.ts";
import type { SidebarMachine } from "../../lib/machines.ts";
import { projectScopeAtom } from "./useGtdShelves.ts";

export interface GtdFilterState {
  projects: readonly { id: string; name: string }[];
  scope: string | null;
  machines: readonly SidebarMachine[];
  hiddenMachineIds: ReadonlySet<string>;
  changeMachines(change: MachineVisibilityChange): void;
}

const GtdFilterContext = createContext<GtdFilterState | null>(null);
export const GtdFilterProvider = GtdFilterContext.Provider;

function CheckSlot({ checked }: { checked: boolean }) {
  return (
    <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
      {checked && <Icon name="Check" className="size-4" />}
    </span>
  );
}

export function GtdFilterItems() {
  const filters = useContext(GtdFilterContext);
  const setScope = useSetAtom(projectScopeAtom);
  if (filters === null) return null;
  const machineIds = filters.machines.map((machine) => machine.id);
  return (
    <>
      <DropdownMenuGroup aria-label="Project">
        <DropdownMenuLabel>Project</DropdownMenuLabel>
        {[{ id: null, name: "All projects" }, ...filters.projects].map((project) => (
          <DropdownMenuItem
            key={project.id ?? "all"}
            role="menuitemradio"
            aria-checked={filters.scope === project.id}
            onSelect={(event) => {
              event.preventDefault();
              setScope(project.id);
            }}
          >
            <span className="min-w-0 truncate">{project.name}</span>
            <CheckSlot checked={filters.scope === project.id} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
      {filters.machines.length > 1 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup aria-label="Machines">
            <DropdownMenuLabel>Machines</DropdownMenuLabel>
            {filters.machines.map((machine) => {
              const visible = !filters.hiddenMachineIds.has(machine.id);
              const onlyVisible =
                visible && filters.hiddenMachineIds.size === machineIds.length - 1;
              return (
                <DropdownMenuItem
                  key={machine.id}
                  role="menuitemcheckbox"
                  aria-checked={visible}
                  title={onlyVisible ? "Keep at least one machine shown" : undefined}
                  onSelect={(event) => {
                    event.preventDefault();
                    if (onlyVisible) return;
                    filters.changeMachines({
                      kind: "set",
                      machineId: machine.id,
                      visible: !visible,
                      machineIds,
                    });
                  }}
                >
                  <span className="min-w-0 truncate">{machine.name}</span>
                  <CheckSlot checked={visible} />
                </DropdownMenuItem>
              );
            })}
            {filters.hiddenMachineIds.size > 0 ? (
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  filters.changeMachines({ kind: "all" });
                }}
              >
                Show all machines
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
        </>
      ) : null}
    </>
  );
}
