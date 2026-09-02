import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  AlarmClockIcon,
  Archive02Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowTurnBackwardIcon,
  ArrowUp01Icon,
  CancelCircleIcon,
  CheckListIcon,
  Clock01Icon,
  ComputerTerminal01Icon,
  Delete02Icon,
  Edit02Icon,
  HelpCircleIcon,
  Loading03Icon,
  Mail01Icon,
  MailOpen01Icon,
  PinIcon,
  PinOffIcon,
  SidebarRight01Icon,
  SparklesIcon,
  Target02Icon,
  Tick02Icon,
  UserAdd01Icon,
  WorkflowCircle03Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";

const ICON_MAP = {
  AlarmClock: AlarmClockIcon,
  Archive: Archive02Icon,
  ArrowTurnBackward: ArrowTurnBackwardIcon,
  Check: Tick02Icon,
  ChevronDown: ArrowDown01Icon,
  ChevronLeft: ArrowLeft01Icon,
  ChevronUp: ArrowUp01Icon,
  CircleQuestion: HelpCircleIcon,
  CircleX: CancelCircleIcon,
  Clock: Clock01Icon,
  Delete: Delete02Icon,
  Edit: Edit02Icon,
  ListTodo: CheckListIcon,
  Loading: Loading03Icon,
  Mail: Mail01Icon,
  MailOpen: MailOpen01Icon,
  Pin: PinIcon,
  PinOff: PinOffIcon,
  SidebarRight: SidebarRight01Icon,
  Sparkles: SparklesIcon,
  Target: Target02Icon,
  Terminal: ComputerTerminal01Icon,
  UserRoundPlus: UserAdd01Icon,
  Workflow: WorkflowCircle03Icon,
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
      data-icon={name}
    />
  );
}
