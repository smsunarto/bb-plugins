// Codex's Daybreak, under the effort slider: a labelled switch that turns the agent option
// on or off. BB's own picker holds the value; see bb-picker-driver.ts.
import { useId } from "react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { DaybreakGlyph } from "./glyphs";
import type { AgentSwitchTrait } from "./traits";

/** The row's switch, for the panel's arrow keys; a disabled one cannot take focus, so they pass it by. */
export const AGENT_SWITCH = '[role="switch"][data-t3-agent-switch]:not(:disabled)';

export function AgentSwitchRow(props: {
  option: AgentSwitchTrait;
  /** Null until BB's picker has been read. */
  on: boolean | null;
  pending: boolean;
  large: boolean;
  onToggle(): void;
}) {
  const { option, on, large } = props;
  const id = useId();
  const fixed = option.fixed !== undefined;
  const checking = on === null;
  // Unknown, a press could not say which way it goes. In flight it stays enabled, so focus
  // can return to it, and the panel ignores a second press until the first lands.
  const disabled = fixed || checking;
  const note = fixed ? "Set by this model" : checking ? "Checking…" : null;
  return (
    // The whole row is the switch's label, so a tap anywhere on it toggles.
    <label
      htmlFor={id}
      data-t3-agent-switch-row=""
      title={option.description}
      className={cn(
        "flex w-full min-w-0 items-center gap-3 rounded-lg",
        large ? "min-h-12 px-3" : "min-h-8 px-2",
        disabled || props.pending ? "cursor-default" : "cursor-pointer active:bg-state-active",
      )}
    >
      <DaybreakGlyph
        className={cn("shrink-0 text-muted-foreground", large ? "size-5" : "size-4")}
      />
      <span
        className={cn("min-w-0 flex-1 truncate text-foreground", large ? "text-base" : "text-sm")}
      >
        {option.label}
      </span>
      {/* One line either way, so the panel keeps its height once the value is read. */}
      {note ? (
        <span className={cn("shrink-0 text-muted-foreground", large ? "text-sm" : "text-xs")}>
          {note}
        </span>
      ) : null}
      <Switch
        id={id}
        data-t3-agent-switch={option.id}
        size={large ? "default" : "sm"}
        checked={on === true}
        disabled={disabled}
        aria-busy={checking || props.pending || undefined}
        onCheckedChange={() => props.onToggle()}
      />
    </label>
  );
}
