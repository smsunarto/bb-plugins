import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Icon } from "../ui/icon";
import { usePortalScopeProps } from "../../lib/portal-scope";
import type { MachineVisibilityChange } from "../../lib/machine-visibility";
import type { machineVisibility, SidebarMachine } from "../../lib/machines";
import { SelectTrigger } from "../ui/select";
import { MachineGlobe } from "./machine-globe";
import { cn } from "../../lib/utils";

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
function scopeTriggerClassName(isCompactViewport: boolean, className?: string) {
  return cn(
    "h-6 w-auto gap-1 border-0 border-transparent px-1.5 py-1 text-xs text-muted-foreground shadow-none hover:bg-sidebar-accent focus:ring-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[pointer-focus]:focus-visible:ring-0 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-foreground",
    isCompactViewport && "min-h-10",
    className,
  );
}

/**
 * Radix refocuses the trigger by script when its popup closes. Chrome then
 * matches :focus-visible from the input before it, often a keypress in the
 * composer, so a mouse pick would draw the keyboard ring. The ring follows
 * the input that led to this focus instead.
 */
function useFocusRingSource() {
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
  return {
    "data-pointer-focus": pointerFocus || undefined,
    onFocus: () => setPointerFocus(lastInput.current === "pointer"),
    onKeyDown: () => setPointerFocus(false),
  };
}

export function ScopeTrigger({
  isCompactViewport,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof SelectTrigger> & { isCompactViewport: boolean }) {
  return (
    <SelectTrigger
      {...props}
      {...useFocusRingSource()}
      className={scopeTriggerClassName(isCompactViewport, className)}
    />
  );
}

export function MachineVisibilityPicker({
  machines,
  visibility,
  onChange,
  isCompactViewport,
}: {
  machines: readonly SidebarMachine[];
  visibility: ReturnType<typeof machineVisibility>;
  onChange: (change: MachineVisibilityChange) => void;
  isCompactViewport: boolean;
}) {
  const { visible, hiddenMachineIds, active } = visibility;
  const selectedMachine = active && visible.length === 1 ? visible[0] : null;
  const label = !active
    ? "All machines"
    : (selectedMachine?.name ?? `${visible.length}/${machines.length}`);
  const accessibleLabel =
    active && !selectedMachine ? `${visible.length} of ${machines.length}` : label;
  const machineIds = machines.map((machine) => machine.id);
  const itemClassName = cn(
    "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-state-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 aria-[disabled=true]:opacity-50",
    scopeItemClassName(isCompactViewport),
  );
  const focusRing = useFocusRingSource();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          {...focusRing}
          aria-label={`Visible machines: ${accessibleLabel}`}
          title={label}
          className={scopeTriggerClassName(
            isCompactViewport,
            "ml-auto flex max-w-[60%] shrink-0 items-center whitespace-nowrap rounded-md bg-transparent transition-colors duration-150 hover:duration-0 focus:outline-none",
          )}
        >
          <MachineGlobe machine={selectedMachine ?? null} />
          <span className="truncate">{label}</span>
          <Icon name="ChevronDown" className="size-4 shrink-0 opacity-50" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...usePortalScopeProps()}
          align="end"
          sideOffset={4}
          aria-label="Visible machines"
          aria-labelledby={undefined}
          className="z-50 min-w-48 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          style={{ maxHeight: "var(--radix-dropdown-menu-content-available-height)" }}
        >
          <DropdownMenu.Item className={itemClassName} onSelect={() => onChange({ kind: "all" })}>
            <MachineGlobe machine={null} />
            All machines
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {machines.map((machine) => {
            const checked = !hiddenMachineIds.has(machine.id);
            // aria-disabled, not Radix's `disabled`, which drops the item from
            // arrow-key navigation and hides that it is still checked.
            const locked = checked && visible.length === 1;
            return (
              <div key={machine.id} className="flex items-center">
                <DropdownMenu.CheckboxItem
                  checked={checked}
                  aria-disabled={locked || undefined}
                  onCheckedChange={(next) => {
                    if (locked) return;
                    onChange({
                      kind: "set",
                      machineId: machine.id,
                      visible: next === true,
                      machineIds,
                    });
                  }}
                  onSelect={(event) => event.preventDefault()}
                  className={cn(itemClassName, "min-w-0 flex-1")}
                  textValue={machine.name}
                  aria-label={machine.name}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <DropdownMenu.ItemIndicator>
                      <Icon name="Check" className="size-4" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  <MachineGlobe machine={machine} />
                  <span className="truncate">{machine.name}</span>
                </DropdownMenu.CheckboxItem>
                <DropdownMenu.Item
                  className={cn(itemClassName, "shrink-0 text-muted-foreground")}
                  aria-label={`Only ${machine.name}`}
                  textValue={`Only ${machine.name}`}
                  onSelect={() => onChange({ kind: "only", machineId: machine.id, machineIds })}
                >
                  Only
                </DropdownMenu.Item>
              </div>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
