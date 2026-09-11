import type { IconName } from "@/components/ui/icon";

export type ActiveThreadShelf = "pinned" | "nextAction" | "waiting";

export type RowCommand =
  | {
      kind: "open";
      threadId: string;
      shelf: ActiveThreadShelf | "snoozed" | "settled";
      split: boolean;
    }
  | { kind: "settle"; threadId: string }
  | { kind: "snooze"; threadId: string; until: number }
  | { kind: "restore"; threadId: string; shelf: "snoozed" | "settled" }
  | { kind: "pin"; threadId: string; pinned: boolean }
  | { kind: "request-delete"; threadId: string };

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

export type ThreadActionId =
  | "settle"
  | "snooze-tomorrow"
  | "wake-now"
  | "unsettle"
  | "toggle-pin"
  | "request-delete";

export interface ThreadAction {
  id: ThreadActionId;
  label: string;
  icon: IconName;
  execute: () => void;
  destructive?: boolean;
}

/**
 * A row's menu in the order iOS would list it: the lifecycle move, then pin,
 * then delete. The phone sheet and the desktop right-click menu both show it
 * whole; the card's hover buttons pick single entries out of it.
 */
export type ThreadActionPlan = readonly ThreadAction[];

export interface BuildThreadActionPlanOptions {
  lifecycle: RowLifecycleState;
  isPinned: boolean;
  setPinned: (pinned: boolean) => void;
  requestDelete: () => void;
}

function lifecycleActions(lifecycle: RowLifecycleState): ThreadAction[] {
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
          label: "Snooze",
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

export function buildThreadActionPlan({
  lifecycle,
  isPinned,
  setPinned,
  requestDelete,
}: BuildThreadActionPlanOptions): ThreadActionPlan {
  return [
    ...lifecycleActions(lifecycle),
    {
      id: "toggle-pin",
      label: isPinned ? "Unpin" : "Pin",
      icon: isPinned ? "PinOff" : "Pin",
      execute: () => setPinned(!isPinned),
    },
    {
      id: "request-delete",
      label: "Delete",
      icon: "Delete",
      execute: requestDelete,
      destructive: true,
    },
  ];
}

export function findThreadAction(
  plan: ThreadActionPlan,
  actionId: ThreadActionId,
): ThreadAction | undefined {
  return plan.find(({ id }) => id === actionId);
}
