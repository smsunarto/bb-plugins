import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * The curated project icon set. `Initiative.icon` stores one of these keys;
 * unknown keys (a renamed set, a hand-edited row) fall back to Folder rather
 * than rendering nothing.
 */
export const INITIATIVE_ICONS = [
  { key: "folder", icon: "Folder", label: "Folder" },
  { key: "rocket", icon: "Rocket", label: "Rocket" },
  { key: "star", icon: "Star", label: "Star" },
  { key: "zap", icon: "Zap", label: "Zap" },
  { key: "bot", icon: "Bot", label: "Bot" },
  { key: "brain", icon: "Brain", label: "Brain" },
  { key: "sparkles", icon: "Sparkles", label: "Sparkles" },
  { key: "compass", icon: "Compass", label: "Compass" },
  { key: "cube", icon: "Cube", label: "Cube" },
  { key: "diamond", icon: "Diamond", label: "Diamond" },
  { key: "fire", icon: "Fire", label: "Fire" },
  { key: "gem", icon: "Gem", label: "Gem" },
  { key: "leaf", icon: "Leaf", label: "Leaf" },
  { key: "package", icon: "Package", label: "Package" },
  { key: "puzzle", icon: "Puzzle", label: "Puzzle" },
  { key: "shield", icon: "Shield", label: "Shield" },
  { key: "trophy", icon: "Trophy", label: "Trophy" },
  { key: "wrench", icon: "Wrench", label: "Wrench" },
  { key: "code", icon: "Code", label: "Code" },
  { key: "kanban", icon: "Kanban", label: "Kanban" },
  { key: "globe", icon: "Globe", label: "Globe" },
  { key: "flag", icon: "Flag", label: "Flag" },
  { key: "bookmark", icon: "Bookmark", label: "Bookmark" },
  { key: "home", icon: "Home", label: "Home" },
] as const satisfies readonly { key: string; icon: IconName; label: string }[];

export type InitiativeIconKey = (typeof INITIATIVE_ICONS)[number]["key"];

const BY_KEY: ReadonlyMap<string, IconName> = new Map(
  INITIATIVE_ICONS.map((entry) => [entry.key, entry.icon]),
);

export function initiativeIconName(key: string): IconName {
  return BY_KEY.get(key) ?? "Folder";
}

export function InitiativeIcon({ icon, className }: { icon: string; className?: string }) {
  return (
    <Icon
      name={initiativeIconName(icon)}
      className={cn("size-4 shrink-0", className)}
      aria-hidden
    />
  );
}

/** Grid picker used by create/edit surfaces; one click commits. */
export function InitiativeIconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <fieldset aria-label="Project icon" className="grid grid-cols-8 gap-1">
      {INITIATIVE_ICONS.map(({ key, icon, label }) => (
        <button
          key={key}
          type="button"

          aria-pressed={key === value}
          aria-label={label}
          title={label}
          onClick={() => onChange(key)}
          className={cn(
            "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground",
            key === value && "bg-accent text-foreground ring-1 ring-ring",
          )}
        >
          <Icon name={icon} className="size-4" aria-hidden />
        </button>
      ))}
    </fieldset>
  );
}
