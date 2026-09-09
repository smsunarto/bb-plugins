import { Icon } from "@/components/ui/icon";
import { machineColor, type SidebarMachine } from "@/lib/machines";
import { cn } from "@/lib/utils";

export function MachineGlobe({
  machine,
  className,
}: {
  machine: SidebarMachine | null;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex shrink-0 items-center", className)}
      style={machine ? { color: machineColor(machine.id) } : undefined}
      title={machine?.name}
      aria-hidden="true"
      data-machine-id={machine?.id}
    >
      <Icon name="Globe" className="size-3" aria-hidden="true" />
    </span>
  );
}
