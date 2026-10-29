// Codex's speed bolt, in the model picker beside its search box: each press
// moves to the next speed, Normal → Fast (→ Ultrafast) → Normal.
import { Icon } from "@/components/ui/icon";
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

export function SpeedToggle(props: { speed: SpeedTrait; onChange(tier: string): void }) {
  const { current, next, active } = speedCycle(props.speed);
  // A button that steps through tiers, so its label carries the state; no aria-pressed.
  const label = `Speed: ${current.label}. Switch to ${next.label}`;
  return (
    <button
      type="button"
      data-t3-speed-toggle=""
      data-active={active ? "" : undefined}
      aria-label={label}
      title={next.description ? `${label}: ${next.description}` : label}
      // A pointer press leaves focus in the search box, so typing still filters the list.
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => props.onChange(next.id)}
      className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.08] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:text-foreground"
    >
      {active ? (
        <span className="flex size-4 items-center justify-center [&_svg]:size-3.5">
          <FastBolt ultra={active.ultra} />
        </span>
      ) : (
        <Icon name="Zap" className="size-4" aria-hidden />
      )}
    </button>
  );
}
