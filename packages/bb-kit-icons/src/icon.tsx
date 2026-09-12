import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Archive03Icon,
  ArrowDown01Icon,
  ArrowReloadHorizontalIcon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  AtSignIcon,
  Cancel01Icon,
  ChatFeedback01Icon,
  DashedLineCircleIcon,
  Delete02Icon,
  GitMergeIcon,
  GitPullRequestArrow,
  LinkSquare02Icon,
  Refresh01Icon,
  Settings01Icon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";

// Only the names plugins render. Add an entry when a plugin needs a new glyph.
const ICON_MAP = {
  Archive: Archive03Icon,
  ArrowReloadHorizontal: ArrowReloadHorizontalIcon,
  ArrowUp: ArrowUp02Icon,
  AtSign: AtSignIcon,
  ChatFeedback: ChatFeedback01Icon,
  Check: Tick02Icon,
  ChevronDown: ArrowDown01Icon,
  ChevronUp: ArrowUp01Icon,
  ExternalLink: LinkSquare02Icon,
  GitMerge: GitMergeIcon,
  GitPullRequestArrow: GitPullRequestArrow,
  RotateCcw: Refresh01Icon,
  Settings: Settings01Icon,
  Sparkles: SparklesIcon,
  Spinner: DashedLineCircleIcon,
  Trash2: Delete02Icon,
  X: Cancel01Icon,
} as const satisfies Record<string, IconSvgElement>;

export type IconName = keyof typeof ICON_MAP;

export const ICON_NAMES = Object.keys(ICON_MAP) as readonly IconName[];

export interface IconProps {
  name: IconName;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

export function Icon({
  name,
  className,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: IconProps) {
  return (
    <HugeiconsIcon
      icon={ICON_MAP[name]}
      className={className}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
      data-icon={name}
    />
  );
}
