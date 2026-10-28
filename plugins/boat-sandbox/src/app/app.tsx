// Frontend: the composer chip that picks a Boat sandbox size and, when the
// account has saved snapshots, the snapshot a new sandbox starts from. The
// choice is persisted on the launch as the machine inputs the server parses.
import { useEffect, useState } from "react";
import {
  definePluginApp,
  useRpc,
  type JsonValue,
  type PluginMachineProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
} from "@/components/ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MENU_CONTENT_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
} from "@/components/ui/option-display";
import { cn } from "@/lib/utils";
import { PROVIDER_ID, SANDBOX_TYPES, type SandboxType } from "../shared/constants.ts";
import type { boatRpcContract } from "../shared/rpc.ts";
import type { LaunchOptions } from "../shared/schema.ts";

const FRESH_LABEL = "Fresh Ubuntu";

function selected(value: JsonValue | null, key: "type" | "from"): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entry = value[key];
  return typeof entry === "string" ? entry : undefined;
}

function isSandboxType(value: string | undefined): value is SandboxType {
  return value !== undefined && (SANDBOX_TYPES as readonly string[]).includes(value);
}

function machineInputs(type: SandboxType | undefined, from: string | undefined): JsonValue {
  return {
    ...(type === undefined ? {} : { type }),
    ...(from === undefined ? {} : { from }),
  };
}

function OptionItem({
  label,
  detail,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      disabled={disabled}
      className="flex items-start justify-between gap-3 whitespace-normal"
    >
      <span className="min-w-0 flex-1 whitespace-normal break-words text-xs">
        {label}
        {detail ? <span className="block text-muted-foreground">{detail}</span> : null}
      </span>
      <Icon
        name="Check"
        className={cn(
          COARSE_POINTER_ICON_SIZE_CLASS,
          "shrink-0",
          selected ? "opacity-100" : "opacity-0",
        )}
      />
    </DropdownMenuItem>
  );
}

function BoatMachineInputs({ value, onChange }: PluginMachineProviderInputsProps) {
  const rpc = useRpc<typeof boatRpcContract>();
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const chosenType = selected(value, "type");
  const chosenFrom = selected(value, "from");
  const type = isSandboxType(chosenType) ? chosenType : undefined;

  useEffect(() => {
    onChange({ status: "ready", value: machineInputs(type, chosenFrom) });
  }, [onChange, type, chosenFrom]);

  // A snapshot that was deleted or is still saving must not ride along into the launch.
  const staleFrom =
    options !== null && chosenFrom !== undefined && !options.snapshots.includes(chosenFrom);
  useEffect(() => {
    if (staleFrom) onChange({ status: "ready", value: machineInputs(type, undefined) });
  }, [onChange, staleFrom, type]);

  useEffect(() => {
    let active = true;
    rpc.call("launch.options", {}).then(
      (result) => {
        if (active) setOptions(result);
        return undefined;
      },
      () => {
        if (active) setOptions(null);
        return undefined;
      },
    );
    return () => {
      active = false;
    };
  }, [rpc]);

  if (options === null) return null;
  const effectiveType = type ?? options.defaultType;
  const effectiveFrom = staleFrom ? undefined : chosenFrom;
  const choose = (nextType: SandboxType | undefined, nextFrom: string | undefined) => {
    onChange({ status: "ready", value: machineInputs(nextType, nextFrom) });
  };
  const label = effectiveFrom === undefined ? effectiveType : `${effectiveType} · ${effectiveFrom}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Boat sandbox options"
          data-promptbox-shrinkable-control=""
          className={cn(
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            OPTION_MUTED_CLASS_NAME,
          )}
        >
          <span className="min-w-0 truncate">{label}</span>
          <Icon
            name="ChevronDown"
            className={cn("shrink-0 text-muted-foreground", COARSE_POINTER_COMPACT_ICON_SIZE_CLASS)}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={cn(OPTION_MENU_CONTENT_CLASS_NAME, "max-w-72")}>
        <DropdownMenuLabel>Size</DropdownMenuLabel>
        {options.types.map((entry) => (
          <OptionItem
            key={entry.type}
            label={entry.type}
            detail={entry.available ? undefined : (entry.reason ?? "Not available on this plan")}
            disabled={!entry.available}
            selected={entry.type === effectiveType}
            onSelect={() => choose(entry.type, effectiveFrom)}
          />
        ))}
        {options.snapshots.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Start from</DropdownMenuLabel>
            <OptionItem
              label={FRESH_LABEL}
              selected={effectiveFrom === undefined}
              onSelect={() => choose(type, undefined)}
            />
            {options.snapshots.map((name) => (
              <OptionItem
                key={name}
                label={name}
                selected={name === effectiveFrom}
                onSelect={() => choose(type, name)}
              />
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_machineProviderInputs({
    machineProviderId: PROVIDER_ID,
    component: BoatMachineInputs,
  });
});
