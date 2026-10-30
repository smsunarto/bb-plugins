// Codex's speed bolt, at the top left of the effort panel: each press moves to
// the next speed, Normal → Fast (→ Ultrafast) → Normal.
import type { ReactNode } from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { FastBolt } from "./glyphs";
import { DEFAULT_SERVICE_TIER, type SpeedTrait } from "./traits";

/** The model's speeds in order, with the current one and the one a press moves to. */
export function speedCycle(speed: SpeedTrait) {
  const tiers =
    speed.kind === "toggle"
      ? [{ id: DEFAULT_SERVICE_TIER, label: "Normal", isDefault: true }, speed.tier]
      : speed.options;
  // An unknown tier reads as Normal throughout, so the label and bolt agree.
  const at = Math.max(
    0,
    tiers.findIndex((tier) => tier.id === speed.current),
  );
  const current = tiers[at]!;
  return {
    current,
    next: tiers[(at + 1) % tiers.length]!,
    /** The faster tier in use, by the provider's label; Ultrafast gets the double bolt. */
    active:
      current.id === DEFAULT_SERVICE_TIER
        ? null
        : { label: current.label, ultra: current.id === "ultrafast" },
  };
}

/**
 * A button in the effort panel's header, which keeps the panel open. On desktop it is a menu
 * item, so the panel's arrow keys reach it; the phone sheet's menu items drop their labels, so
 * there it is a plain button.
 */
export function PanelIconButton(props: {
  large: boolean;
  label: string;
  title: string;
  active: boolean;
  disabled?: boolean;
  data: Record<`data-${string}`, string>;
  onPress(): void;
  children: ReactNode;
}) {
  const className = cn(
    "flex shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground outline-none data-[highlighted]:text-foreground data-[active]:text-foreground data-[disabled]:opacity-50",
    props.large ? "size-11 active:bg-state-active" : "size-8",
  );
  const shared = {
    ...props.data,
    "data-active": props.active ? "" : undefined,
    "aria-label": props.label,
    title: props.title,
    className,
  };
  if (props.large) {
    return (
      <button
        type="button"
        {...shared}
        disabled={props.disabled}
        data-disabled={props.disabled ? "" : undefined}
        onClick={props.onPress}
      >
        {props.children}
      </button>
    );
  }
  return (
    <DropdownMenuItem
      {...shared}
      textValue={props.label}
      disabled={props.disabled}
      // The panel stays open, as Codex's does.
      onSelect={(event) => {
        event.preventDefault();
        props.onPress();
      }}
    >
      {props.children}
    </DropdownMenuItem>
  );
}

export function SpeedToggle(props: {
  speed: SpeedTrait;
  large: boolean;
  onChange(tier: string): void;
}) {
  const { current, next, active } = speedCycle(props.speed);
  // A button that steps through tiers, so its label carries the state; no aria-pressed.
  const label = `Speed: ${current.label}. Switch to ${next.label}`;
  return (
    <PanelIconButton
      large={props.large}
      label={label}
      title={next.description ? `${label}: ${next.description}` : label}
      active={active !== null}
      data={{ "data-t3-speed-toggle": "" }}
      onPress={() => props.onChange(next.id)}
    >
      {active ? (
        <span className="flex size-4 items-center justify-center [&_svg]:size-3.5">
          <FastBolt ultra={active.ultra} />
        </span>
      ) : (
        <Icon name="Zap" className="size-4" aria-hidden />
      )}
    </PanelIconButton>
  );
}
