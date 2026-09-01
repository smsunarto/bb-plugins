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
  | "open-in-split"
  | "snooze-tomorrow"
  | "settle"
  | "wake-now"
  | "unsettle"
  | "toggle-read"
  | "toggle-pin"
  | "rename-thread"
  | "archive"
  | "request-delete";

export interface ThreadAction {
  id: ThreadActionId;
  label: string;
  execute: () => void;
}

export type ThreadActionGroupId = "primary" | "organization" | "destructive";

export interface ThreadActionPlan {
  primary: readonly ThreadAction[];
  organization: readonly ThreadAction[];
  destructive: readonly ThreadAction[];
}

export interface ThreadActionGroup {
  id: ThreadActionGroupId;
  actions: readonly ThreadAction[];
}

export interface BuildThreadActionPlanOptions {
  lifecycle: RowLifecycleState;
  split: { isAvailable: boolean; open: () => void };
  isUnread: boolean;
  isPinned: boolean;
  setRead: (read: boolean) => void;
  setPinned: (pinned: boolean) => void;
  renameThread: () => void;
  archive: () => void;
  requestDelete: () => void;
}

const GROUP_ORDER: readonly ThreadActionGroupId[] = ["primary", "organization", "destructive"];

export function buildThreadActionPlan({
  lifecycle,
  split,
  isUnread,
  isPinned,
  setRead,
  setPinned,
  renameThread,
  archive,
  requestDelete,
}: BuildThreadActionPlanOptions): ThreadActionPlan {
  const primary: ThreadAction[] = split.isAvailable
    ? [{ id: "open-in-split", label: "Open in split", execute: split.open }]
    : [];

  switch (lifecycle.kind) {
    case "active":
      if (lifecycle.canPark) {
        primary.push(
          {
            id: "snooze-tomorrow",
            label: "Snooze until tomorrow",
            execute: lifecycle.snoozeUntilTomorrow,
          },
          { id: "settle", label: "Settle thread", execute: lifecycle.settle },
        );
      }
      break;
    case "snoozed":
      primary.push({ id: "wake-now", label: "Wake thread now", execute: lifecycle.wakeNow });
      break;
    case "settled":
      primary.push({ id: "unsettle", label: "Un-settle thread", execute: lifecycle.unsettle });
      break;
  }

  return {
    primary,
    organization: [
      {
        id: "rename-thread",
        label: "Generate thread name",
        execute: renameThread,
      },
      {
        id: "toggle-read",
        label: isUnread ? "Mark read" : "Mark unread",
        execute: () => setRead(isUnread),
      },
      {
        id: "toggle-pin",
        label: isPinned ? "Unpin" : "Pin",
        execute: () => setPinned(!isPinned),
      },
    ],
    destructive: [
      { id: "archive", label: "Archive", execute: archive },
      { id: "request-delete", label: "Delete", execute: requestDelete },
    ],
  };
}

export function getThreadActionGroups(plan: ThreadActionPlan): readonly ThreadActionGroup[] {
  return GROUP_ORDER.flatMap((id) => (plan[id].length === 0 ? [] : [{ id, actions: plan[id] }]));
}

export function findThreadAction(
  plan: ThreadActionPlan,
  actionId: ThreadActionId,
): ThreadAction | undefined {
  for (const group of getThreadActionGroups(plan)) {
    const action = group.actions.find(({ id }) => id === actionId);
    if (action !== undefined) return action;
  }
  return undefined;
}
