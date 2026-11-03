import { Icon } from "../ui/icon";
import type { SidebarMachine } from "../../lib/machines";
import { cn } from "../../lib/utils";
import { useIsBoatMachine, useMachineColors } from "./machine-appearance";

export function MachineGlobe({
  machine,
  className,
}: {
  machine: SidebarMachine | null;
  className?: string;
}) {
  const isBoat = useIsBoatMachine(machine?.id);
  const colorOf = useMachineColors();
  return (
    <span
      className={cn("inline-flex shrink-0 items-center", className)}
      style={
        isBoat
          ? { color: "var(--muted-foreground)" }
          : machine
            ? { color: colorOf(machine.id) }
            : undefined
      }
      title={machine?.name}
      aria-hidden="true"
      data-machine-id={machine?.id}
    >
      <Icon name={isBoat ? "Bot" : "Globe"} className="size-3" aria-hidden="true" />
    </span>
  );
}
