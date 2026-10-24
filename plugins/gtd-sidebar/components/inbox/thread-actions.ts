import type { IconName } from "../ui/icon";

export type ActiveThreadShelf = "pinned" | "nextAction" | "waiting";

/** The snooze's name in menus and on the row's button. The toast states the time. */
export const SNOOZE_TOMORROW_LABEL = "Snooze until tomorrow";

export type RowCommand =
  | { kind: "open"; threadId: string; split: boolean }
  | { kind: "settle"; threadId: string }
  | { kind: "snooze"; threadId: string; until: number }
  | { kind: "restore"; threadId: string; shelf: "snoozed" | "settled" };

export type DispatchRowCommand = (command: RowCommand) => void;

export type RowLifecycleState =
  | {
      kind: "active";
      canPark: boolean;
      snoozeUntilTomorrow: () => void;
      settle: () => void;
    }
  | { kind: "snoozed"; wakeNow: () => void }
  | { kind: "settled"; unsettle: () => void };

export type ThreadActionId = "settle" | "snooze-tomorrow" | "wake-now" | "unsettle";

export interface ThreadAction {
  id: ThreadActionId;
  label: string;
  icon: IconName;
  execute: () => void;
}

/**
 * The GTD lifecycle moves for one row. Both menus lead with them, then list
 * bb's thread actions (split, copy link, pin, read, rename, delete, and every
 * plugin's) from its registry through ThreadMenuActions. The card's hover
 * buttons pick single entries out of it.
 */
export type ThreadActionPlan = readonly ThreadAction[];

export function buildThreadActionPlan(lifecycle: RowLifecycleState): ThreadActionPlan {
  switch (lifecycle.kind) {
    case "active": {
      // Settle is bb's archive, which bb offers on every thread, so it is not
      // gated on `canPark` the way a snooze is.
      const actions: ThreadAction[] = [
        { id: "settle", label: "Settle", icon: "Check", execute: lifecycle.settle },
      ];
      if (lifecycle.canPark) {
        actions.push({
          id: "snooze-tomorrow",
          label: SNOOZE_TOMORROW_LABEL,
          icon: "Clock",
          execute: lifecycle.snoozeUntilTomorrow,
        });
      }
      return actions;
    }
    case "snoozed":
      return [
        { id: "wake-now", label: "Wake now", icon: "AlarmClock", execute: lifecycle.wakeNow },
      ];
    case "settled":
      return [
        {
          id: "unsettle",
          label: "Un-settle",
          icon: "ArrowTurnBackward",
          execute: lifecycle.unsettle,
        },
      ];
  }
}

export function findThreadAction(
  plan: ThreadActionPlan,
  actionId: ThreadActionId,
): ThreadAction | undefined {
  return plan.find(({ id }) => id === actionId);
}
