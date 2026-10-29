// Adapted from T3 Code's TraitsPicker.tsx: a muted effort word that
// reads on from the model name, a bolt for faster tiers, and an Effort/Speed menu.
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { FastBolt } from "./glyphs";
import { DEFAULT_SERVICE_TIER, speedLabel, type TraitOption, type Traits } from "./traits";

export function TraitsPicker(props: {
  traits: Traits;
  disabled?: boolean;
  onEffortChange(level: string): void;
  onSpeedChange(tier: string): void;
}) {
  const { effort, speed } = props.traits;
  if (!effort && !speed) return null;
  // T3 Code's default effort display: the level's name, not bars.
  const effortWord =
    effort?.options.find((option) => option.id === effort.current)?.label ??
    effort?.current ??
    null;
  const activeSpeed = speedLabel(speed);
  const description = [effortWord ? `Effort: ${effortWord}` : null, activeSpeed]
    .filter(Boolean)
    .join(" · ");

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={props.disabled}
          aria-label={description || "Model options"}
          title={description || undefined}
          data-t3-traits-trigger=""
          data-t3-traits-word={effortWord ? "" : undefined}
          className="shrink-0 whitespace-nowrap"
        >
          <span className="flex items-center gap-1.5">
            {effortWord ? <span>{effortWord}</span> : null}
            {activeSpeed ? <FastBolt ultra={activeSpeed === "Ultrafast"} /> : null}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-t3-composer-menu=""
        align="start"
        mobileTitle="Model options"
        className="min-w-44 max-w-72"
      >
        {effort ? (
          <TraitSection
            label="Effort"
            options={effort.options}
            current={effort.current}
            onSelect={props.onEffortChange}
          />
        ) : null}
        {speed ? (
          <>
            {effort ? <DropdownMenuSeparator /> : null}
            {speed.kind === "toggle" ? (
              <TraitSection
                label={`${speed.tier.label} mode`}
                options={[
                  {
                    id: speed.tier.id,
                    label: "On",
                    isDefault: false,
                    ...(speed.tier.description ? { description: speed.tier.description } : {}),
                  },
                  { id: DEFAULT_SERVICE_TIER, label: "Off", isDefault: false },
                ]}
                current={speed.current === speed.tier.id ? speed.tier.id : DEFAULT_SERVICE_TIER}
                onSelect={props.onSpeedChange}
              />
            ) : (
              <TraitSection
                label="Speed"
                options={speed.options}
                current={speed.current}
                onSelect={props.onSpeedChange}
              />
            )}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TraitSection(props: {
  label: string;
  options: readonly TraitOption[];
  current: string | null;
  onSelect(id: string): void;
}) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="pb-1 pt-1.5">{props.label}</DropdownMenuLabel>
      {props.options.map((option) => {
        const checked = option.id === props.current;
        return (
          <DropdownMenuItem
            key={option.id}
            role="menuitemradio"
            aria-checked={checked}
            onSelect={() => props.onSelect(option.id)}
            className={cn("min-h-7 text-sm", checked && "bg-foreground/[0.08]")}
          >
            <span className="flex w-full min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 truncate">{option.label}</span>
                {option.isDefault ? (
                  <span className="inline-flex h-4 shrink-0 items-center rounded border border-border px-1 text-[10px] font-medium text-muted-foreground">
                    Default
                  </span>
                ) : null}
              </span>
              {option.description ? (
                <span className="max-w-56 text-pretty text-xs text-muted-foreground/80">
                  {option.description}
                </span>
              ) : null}
            </span>
          </DropdownMenuItem>
        );
      })}
    </DropdownMenuGroup>
  );
}
