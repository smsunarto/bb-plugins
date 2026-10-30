// Codex's Daybreak, beside the speed bolt: one press turns the agent option on or off.
// BB's own picker holds the value; see bb-picker-driver.ts.
import { DaybreakGlyph } from "./glyphs";
import { PanelIconButton } from "./SpeedToggle";
import type { AgentSwitchTrait } from "./traits";

export function AgentSwitchToggle(props: {
  option: AgentSwitchTrait;
  /** Null until BB's picker has been read. */
  on: boolean | null;
  pending: boolean;
  large: boolean;
  onToggle(): void;
}) {
  const { option, on } = props;
  const state = on === null ? "checking" : on ? "on" : "off";
  const label = `${option.label}: ${state}`;
  return (
    <PanelIconButton
      large={props.large}
      label={label}
      title={option.description ? `${label}. ${option.description}` : label}
      active={on === true}
      // Unknown or in flight, a press could not say which way it goes.
      disabled={on === null || props.pending}
      data={{ "data-t3-agent-switch": option.id }}
      onPress={props.onToggle}
    >
      <DaybreakGlyph className="size-4" />
    </PanelIconButton>
  );
}
