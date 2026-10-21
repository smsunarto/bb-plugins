import { Icon } from "../ui/icon";
import type { SidebarMachine } from "../../lib/machines";
import { cn } from "../../lib/utils";
import { useMachineColors } from "./machine-appearance";

export function MachineGlobe({
  machine,
  className,
}: {
  machine: SidebarMachine | null;
  className?: string;
}) {
  const colorOf = useMachineColors();
  return (
    <span
      className={cn("inline-flex shrink-0 items-center", className)}
      style={machine ? { color: colorOf(machine.id) } : undefined}
      title={machine?.name}
      aria-hidden="true"
      data-machine-id={machine?.id}
    >
      <Icon name="Globe" className="size-3" aria-hidden="true" />
    </span>
  );
}
