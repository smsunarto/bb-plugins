import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { MachineGlobe } from "./machine-globe";
import type { SidebarMachine } from "@/lib/machines";
import { cn } from "@/lib/utils";

const ALL_MACHINES = "__all__";

export function MachineScopePicker({
  machines,
  value,
  onValueChange,
  isCompactViewport,
}: {
  machines: readonly SidebarMachine[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  isCompactViewport: boolean;
}) {
  const selectedMachine = machines.find((machine) => machine.id === value) ?? null;
  const label = selectedMachine?.name ?? (value === null ? "All machines" : "Unavailable machine");
  return (
    <Select
      value={value ?? ALL_MACHINES}
      onValueChange={(next) => onValueChange(next === ALL_MACHINES ? null : next)}
    >
      <SelectTrigger
        className={cn(
          "h-6 w-auto shrink-0 gap-1 border-0 border-transparent px-1.5 py-1 text-xs text-muted-foreground shadow-none hover:bg-sidebar-accent focus:ring-0",
          isCompactViewport && "min-h-10",
        )}
        aria-label={`Machine scope: ${label}`}
        title={label}
      >
        <MachineGlobe machine={selectedMachine} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_MACHINES} className="text-xs">
          <span className="flex items-center gap-2">
            <MachineGlobe machine={null} />
            All machines
          </span>
        </SelectItem>
        {machines.map((machine) => (
          <SelectItem
            key={machine.id}
            value={machine.id}
            className="text-xs"
            textValue={machine.name}
          >
            <span className="flex items-center gap-2">
              <MachineGlobe machine={machine} />
              {machine.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
