// GTD's additions to bb's thread row: the machine globe, the naming shimmer,
// the snooze wake time, the pull request number, and the long-press haptic.
// The list provides what they read. Each extra is its own component reading
// its own context, so a naming change or a minute tick redraws only that
// extra, never the row.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSdk, useSettings } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useMinuteClock } from "../../hooks/use-minute-clock.ts";
import { useNamingThreads } from "../../hooks/use-naming-threads.ts";
import { useRowPullRequest } from "../../hooks/use-row-pull-request.ts";
import { formatWakeTime, snoozeWakeLabel } from "../../lib/lifecycle.ts";
import { machineColor, useBoatMachineIds } from "../../lib/machine-colors.ts";
import { nativeHaptic } from "../../lib/native-haptics.ts";
import type { ShelfId } from "../../shared/preferences.ts";
import type { SidebarThread } from "../model/sidebar-thread.ts";

// The containing shelf owns presentation, including folders and nested families.
export const GtdShelfContext = createContext<ShelfId | null>(null);

export function useGtdRowContextVisible(): boolean {
  return useContext(GtdShelfContext) !== "settled";
}

interface MachineAppearance {
  /** The machine whose threads go unmarked; null until it is known. */
  localMachineId: string | null;
  boatMachineIds: ReadonlySet<string>;
  haptics: boolean;
}

const NO_MACHINES: MachineAppearance = {
  localMachineId: null,
  boatMachineIds: new Set(),
  haptics: false,
};
const MachineContext = createContext<MachineAppearance>(NO_MACHINES);
const NamingContext = createContext<ReadonlySet<string>>(new Set());
type WakeAtFor = (thread: SidebarThread) => number | null;
const WakeContext = createContext<WakeAtFor>(() => null);

export function GtdRowExtrasProvider({
  hosts,
  wakeAtFor,
  children,
}: {
  hosts: readonly { id: string }[];
  wakeAtFor: WakeAtFor;
  children: ReactNode;
}) {
  const sdk = useSdk();
  const { values, isLoading } = useSettings();
  const setting = typeof values?.localMachineId === "string" ? values.localMachineId.trim() : "";
  const [primaryHostId, setPrimaryHostId] = useState<string | null>(null);
  // An empty setting means bb's primary host, so a one-machine user never
  // sees a globe, not even before the read lands. A failed read marks every
  // machine remote. Until settings load a saved choice may name another
  // machine, so no machine is marked yet.
  useEffect(() => {
    if (setting !== "") return;
    const controller = new AbortController();
    void sdk.system.config({ signal: controller.signal }).then(
      (config) => setPrimaryHostId(config.primaryHostId ?? ""),
      () => {
        if (!controller.signal.aborted) setPrimaryHostId("");
      },
    );
    return () => controller.abort();
  }, [sdk, setting]);
  const boatMachineIds = useBoatMachineIds(hosts);
  const localMachineId = isLoading ? null : setting || primaryHostId;
  const haptics = values?.mobileHaptics === true;
  const machines = useMemo(
    () => ({ localMachineId, boatMachineIds, haptics }),
    [boatMachineIds, haptics, localMachineId],
  );
  const naming = useNamingThreads();
  return (
    <MachineContext.Provider value={machines}>
      <NamingContext.Provider value={naming}>
        <WakeContext.Provider value={wakeAtFor}>{children}</WakeContext.Provider>
      </NamingContext.Provider>
    </MachineContext.Provider>
  );
}

/**
 * A globe before the title when the thread runs on another machine, in that
 * machine's color; a Boat sandbox shows a bot. A local thread shows nothing.
 */
export function GtdMachineGlobe({ host }: { host: SidebarThread["host"] }) {
  const { localMachineId, boatMachineIds } = useContext(MachineContext);
  if (host === null || localMachineId === null || host.id === localMachineId) return null;
  const isBoat = boatMachineIds.has(host.id);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-gtd-machine={host.id}
          role="img"
          aria-label={`On ${host.name}`}
          className="pointer-events-auto relative z-[31] mr-1.5 flex size-4 shrink-0 items-center justify-center"
          style={{ color: isBoat ? "var(--muted-foreground)" : machineColor(host.id) }}
        >
          <Icon name={isBoat ? "Bot" : "Globe"} className="size-3" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{host.name}</TooltipContent>
    </Tooltip>
  );
}

/** Marks the title while GTD names the thread; naming.css draws the shimmer. */
export function useGtdNamingProps(threadId: string): {
  className?: string;
  "data-gtd-naming"?: "true";
} {
  const naming = useContext(NamingContext).has(threadId);
  return naming ? { className: "gtd-naming-text", "data-gtd-naming": "true" } : {};
}

const TRAILING_TEXT_CLASS = "relative shrink-0 text-xs leading-none tabular-nums";

/** How long until a snoozed thread wakes, with the wake time on hover. */
export function GtdWakeTime({ thread }: { thread: SidebarThread }) {
  const wakeAt = useContext(WakeContext)(thread);
  const now = useMinuteClock();
  if (wakeAt === null) return null;
  return (
    <span
      data-gtd-wake=""
      className={cn(TRAILING_TEXT_CLASS, "text-muted-foreground")}
      title={`Wakes ${formatWakeTime(wakeAt, new Date(now))}`}
    >
      {snoozeWakeLabel(wakeAt, now)}
    </span>
  );
}

/**
 * The thread's pull request number, colored by what it needs. bb's metadata
 * line shows the pull request when it is on, so the row shows it only when
 * that line is off.
 */
export function GtdPullRequestNumber({ thread }: { thread: SidebarThread }) {
  const pullRequest = useRowPullRequest(thread.id, thread.environment?.id ?? null);
  if (pullRequest === null) return null;
  return (
    <a
      data-gtd-pull-request=""
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      title={pullRequest.title}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        TRAILING_TEXT_CLASS,
        "pointer-events-auto z-[31] font-mono hover:underline",
        pullRequest.state === "merged"
          ? "text-[color:var(--pr-merged)]"
          : pullRequest.attention === "checks_failed" || pullRequest.attention === "conflicts"
            ? "text-destructive-text"
            : pullRequest.attention === "ready_to_merge"
              ? "text-success-foreground"
              : "text-muted-foreground",
      )}
    >
      #{pullRequest.number}
    </a>
  );
}

/**
 * Plays bb's mobile app haptic as a row's menu opens, when the user opted
 * in. bb's iOS app honors the device's own haptics switch; elsewhere this
 * does nothing.
 */
export function useGtdMenuHaptic(): (open: boolean) => void {
  const { haptics } = useContext(MachineContext);
  return (open) => {
    if (open && haptics) nativeHaptic("impact-medium");
  };
}
