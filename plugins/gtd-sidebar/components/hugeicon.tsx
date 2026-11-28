import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  AlarmClockIcon,
  AnchorIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  ArrowUp01Icon,
  BotIcon,
  Cancel01Icon,
  CircleIcon,
  Clock01Icon,
  Edit02Icon,
  FolderIcon,
  Globe02Icon,
  Home01Icon,
  MoreHorizontalIcon,
  PlusSignIcon,
  Settings01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "../lib/utils";

const ICON_MAP = {
  AlarmClock: AlarmClockIcon,
  Anchor: AnchorIcon,
  ArrowTurnBackward: ArrowTurnBackwardIcon,
  Bot: BotIcon,
  Check: Tick02Icon,
  ChevronDown: ArrowDown01Icon,
  ChevronLeft: ArrowLeft01Icon,
  ChevronRight: ArrowRight01Icon,
  ChevronUp: ArrowUp01Icon,
  Circle: CircleIcon,
  Clock: Clock01Icon,
  Edit: Edit02Icon,
  Folder: FolderIcon,
  Globe: Globe02Icon,
  Home: Home01Icon,
  MoreHorizontal: MoreHorizontalIcon,
  Plus: PlusSignIcon,
  Settings: Settings01Icon,
  X: Cancel01Icon,
} as const satisfies Record<string, IconSvgElement>;

export type IconName = keyof typeof ICON_MAP;

export function Icon({
  name,
  className,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: {
  name: IconName;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}) {
  return (
    <HugeiconsIcon
      icon={ICON_MAP[name]}
      className={cn(className)}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
      // Browsers disagree on a bare svg's role. `img` makes the label the
      // glyph's name everywhere, including inside a row's description.
      role={ariaLabel ? "img" : undefined}
      data-icon={name}
      // The registry kit sizes a menu's glyphs by this attribute, as it does
      // bb's own icons.
      data-icon-root=""
    />
  );
}
