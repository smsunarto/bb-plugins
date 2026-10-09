import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";
import { MachineGlobe } from "./machine-globe";
import type { SidebarMachine } from "../../lib/machines";
import { cn } from "../../lib/utils";

const ALL_MACHINES = "__all__";

/** A scope picker's option: a 40px, 13px-text row on a compact viewport. */
export function scopeItemClassName(isCompactViewport: boolean) {
  return isCompactViewport ? "min-h-10 text-sm" : "text-xs";
}

/**
 * The toolbar's ghost picker trigger: no border, no filled track, so it reads
 * as a label until you hover it. Keyboard focus draws an inset ring, and an
 * open picker keeps the hover fill.
 *
 * `border-transparent` sits beside `border-0` because width and color are
 * separate merge groups: `border-0` alone leaves `border-input` on the
 * element, and a theme may key a recessed background off that class.
 */
export function ScopeTrigger({
  isCompactViewport,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof SelectTrigger> & { isCompactViewport: boolean }) {
  // Radix refocuses the trigger by script when the picker closes. Chrome then
  // matches :focus-visible from the input before it, often a keypress in the
  // composer, so a mouse pick would draw the keyboard ring. The ring follows
  // the input that led to this focus instead.
  const lastInput = useRef<"pointer" | "key">("key");
  const [pointerFocus, setPointerFocus] = useState(false);
  useEffect(() => {
    const onPointer = () => (lastInput.current = "pointer");
    const onKey = () => (lastInput.current = "key");
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);
  return (
    <SelectTrigger
      {...props}
      data-pointer-focus={pointerFocus || undefined}
      onFocus={() => setPointerFocus(lastInput.current === "pointer")}
      onKeyDown={() => setPointerFocus(false)}
      className={cn(
        "h-6 w-auto gap-1 border-0 border-transparent px-1.5 py-1 text-xs text-muted-foreground shadow-none hover:bg-sidebar-accent focus:ring-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[pointer-focus]:focus-visible:ring-0 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-foreground",
        isCompactViewport && "min-h-10",
        className,
      )}
    />
  );
}

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
  const itemClassName = scopeItemClassName(isCompactViewport);
  return (
    <Select
      value={value ?? ALL_MACHINES}
      onValueChange={(next) => onValueChange(next === ALL_MACHINES ? null : next)}
    >
      <ScopeTrigger
        isCompactViewport={isCompactViewport}
        className="ml-auto shrink-0"
        aria-label={`Machine scope: ${label}`}
        title={label}
      >
        <MachineGlobe machine={selectedMachine} />
      </ScopeTrigger>
      <SelectContent>
        <SelectItem value={ALL_MACHINES} className={itemClassName}>
          <span className="flex items-center gap-2">
            <MachineGlobe machine={null} />
            All machines
          </span>
        </SelectItem>
        {machines.map((machine) => (
          <SelectItem
            key={machine.id}
            value={machine.id}
            className={itemClassName}
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
