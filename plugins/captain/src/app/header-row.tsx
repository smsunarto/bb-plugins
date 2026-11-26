/**
 * Publishes Captain ↔ Crew segments into the shared `@bb-plugins/header-bar`
 * Vim-style thread statusbar (`lineage`, `threads`, `action`) and renders
 * nothing itself so only one unified bar appears under the thread header.
 *
 * Gates on the shared cached `captains` read and keyed `crewOf` read before
 * requesting `crewRoster`, publishing zero segments on unrelated threads.
 */
import {
  usePublishHeaderBarSegments,
  type HeaderBarGlyph,
  type HeaderBarMenuItem,
  type HeaderBarSegment,
  type HeaderBarTone,
} from "@bb-plugins/header-bar";
import {
  experimental_useAppPanel as useAppPanel,
  experimental_usePanelTabs as usePanelTabs,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
  type ExperimentalThreadHeaderRowProps,
} from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";
import { DEFAULT_ICON_GLYPH, type CaptainIcon } from "../contract/icon.ts";
import {
  captainContract,
  type CrewRoster,
  type CrewRosterMember,
  type CrewState,
} from "../contract/rpc.ts";
import { CAPTAIN_OVERVIEW_TAB } from "./banner.tsx";
import { useIsCompactViewport } from "./components/ui/hooks/use-compact-viewport.tsx";

/** Slot registration order kept alongside the shared statusbar host (`kitchen-sink` = 10). */
export const CAPTAIN_HEADER_ROW_ORDER = 20;

/** Highest precedence for Captain/Crew lineage and crew switcher slots. */
export const CAPTAIN_SEGMENT_PRIORITY = 10;

const NO_INPUT = {};
const EMPTY_SEGMENTS: readonly HeaderBarSegment[] = [];

const STATE_LABEL: Readonly<Record<CrewState, string>> = {
  working: "Working",
  "needs-input": "Needs input",
  errored: "Errored",
  idle: "Idle",
};

const STATE_RANK: Readonly<Record<CrewState, number>> = {
  "needs-input": 0,
  errored: 1,
  working: 2,
  idle: 3,
};

function captainGlyph(icon: CaptainIcon): HeaderBarGlyph {
  if (icon.kind === "image") return { kind: "image", src: icon.src };
  return {
    kind: "icon",
    name: icon.kind === "icon" ? icon.name : DEFAULT_ICON_GLYPH,
    tone: "default",
  };
}

function crewStateGlyph(state: CrewState): HeaderBarGlyph {
  switch (state) {
    case "working":
      return { kind: "dot", tone: "accent", pulse: true };
    case "needs-input":
      return { kind: "dot", tone: "warning" };
    case "errored":
      return { kind: "dot", tone: "destructive" };
    case "idle":
      return { kind: "dot", tone: "muted" };
  }
}

function worstCrewState(members: readonly CrewRosterMember[]): CrewState {
  let worst: CrewState = "idle";
  for (const member of members) {
    if (STATE_RANK[member.state] < STATE_RANK[worst]) worst = member.state;
  }
  return worst;
}

function crewTriggerTone(state: CrewState): HeaderBarTone {
  if (state === "needs-input") return "warning";
  if (state === "errored") return "destructive";
  return "muted";
}

function buildCrewMenuItems(
  members: readonly CrewRosterMember[],
  currentThreadId: string,
  onNavigate: (threadId: string, split?: boolean) => void,
): readonly HeaderBarMenuItem[] {
  return members.map((member) => {
    const active = member.threadId === currentThreadId;
    const detail = active ? "Current" : (member.role ?? STATE_LABEL[member.state]);
    return {
      id: member.threadId,
      keyText: member.task ?? undefined,
      label: member.title,
      detail,
      glyph: crewStateGlyph(member.state),
      active,
      onSelect: (options) => {
        if (!active) onNavigate(member.threadId, options?.split);
      },
    };
  });
}

function buildDegradedSegments(args: {
  readonly mode: "captain" | "crew";
  readonly captainId: string;
  readonly errorMessage: string;
  readonly retrying: boolean;
  readonly onNavigate: (threadId: string, split?: boolean) => void;
  readonly onRetry: () => void;
}): readonly HeaderBarSegment[] {
  const { mode, captainId, errorMessage, retrying, onNavigate, onRetry } = args;
  const lineage: HeaderBarSegment =
    mode === "crew"
      ? {
          owner: "captain",
          slot: "lineage",
          priority: CAPTAIN_SEGMENT_PRIORITY,
          prefixIcon: "ArrowLeft",
          glyph: { kind: "icon", name: DEFAULT_ICON_GLYPH, tone: "default" },
          label: "Captain",
          tone: "default",
          ariaLabel: "Back to Captain",
          title: errorMessage,
          testId: "captain-hb-lineage",
          onClick: (options) => onNavigate(captainId, options?.split),
        }
      : {
          owner: "captain",
          slot: "lineage",
          priority: CAPTAIN_SEGMENT_PRIORITY,
          glyph: { kind: "icon", name: "AlertTriangle", tone: "warning" },
          label: "Crew unavailable",
          tone: "warning",
          title: errorMessage,
          testId: "captain-hb-degraded",
        };
  return [
    lineage,
    {
      owner: "captain",
      slot: "action",
      priority: CAPTAIN_SEGMENT_PRIORITY,
      label: retrying ? "Retrying…" : "Retry",
      tone: "muted",
      ariaLabel: "Retry loading crew",
      testId: "captain-hb-retry",
      onClick: onRetry,
    },
  ];
}

function buildCrewThreadsSegment(args: {
  readonly title: string;
  readonly ariaLabel: string;
  readonly members: readonly CrewRosterMember[];
  readonly currentThreadId: string;
  readonly onNavigate: (threadId: string, split?: boolean) => void;
}): HeaderBarSegment {
  const { title, ariaLabel, members, currentThreadId, onNavigate } = args;
  const worst = worstCrewState(members);
  return {
    owner: "captain",
    slot: "threads",
    priority: CAPTAIN_SEGMENT_PRIORITY,
    testId: "captain-hb-threads",
    menu: {
      triggerLabel: `${members.length} crew`,
      ariaLabel,
      title,
      glyph: crewStateGlyph(worst),
      tone: crewTriggerTone(worst),
      heading: `Crew (${members.length})`,
      items: buildCrewMenuItems(members, currentThreadId, onNavigate),
      testId: "captain-hb-threads-trigger",
    },
  };
}

function buildCrewSegments(
  roster: CrewRoster,
  threadId: string,
  onNavigate: (threadId: string, split?: boolean) => void,
): readonly HeaderBarSegment[] {
  const { captain, members } = roster;
  const current = members.find((member) => member.threadId === threadId) ?? null;
  const segments: HeaderBarSegment[] = [
    {
      owner: "captain",
      slot: "lineage",
      priority: CAPTAIN_SEGMENT_PRIORITY,
      prefixIcon: "ArrowLeft",
      glyph: captainGlyph(captain.icon),
      label: captain.name,
      tag: current?.role ?? undefined,
      tone: "default",
      shrink: true,
      ariaLabel: `Back to ${captain.name}`,
      title: current?.role
        ? `Back to ${captain.name} (${current.role})`
        : `Back to ${captain.name}`,
      testId: "captain-hb-lineage",
      onClick: (options) => onNavigate(captain.threadId, options?.split),
    },
  ];

  if (members.length > 1) {
    segments.push(
      buildCrewThreadsSegment({
        title: `${captain.name} crew (${members.length})`,
        ariaLabel: `Switch between ${members.length} crew threads`,
        members,
        currentThreadId: threadId,
        onNavigate,
      }),
    );
  }
  return segments;
}

function buildCaptainThreadSegments(args: {
  readonly roster: CrewRoster;
  readonly threadId: string;
  readonly showOverview: boolean;
  readonly onNavigate: (threadId: string, split?: boolean) => void;
  readonly onOpenOverview: () => void;
}): readonly HeaderBarSegment[] {
  const { roster, threadId, showOverview, onNavigate, onOpenOverview } = args;
  const { captain, members } = roster;
  if (members.length === 0 && !showOverview) return EMPTY_SEGMENTS;

  const segments: HeaderBarSegment[] = [
    {
      owner: "captain",
      slot: "lineage",
      priority: CAPTAIN_SEGMENT_PRIORITY,
      glyph: captainGlyph(captain.icon),
      label: members.length === 0 ? "Captain · no active crew" : "Captain",
      tone: "muted",
      testId: "captain-hb-lineage",
    },
  ];

  if (members.length > 0) {
    segments.push(
      buildCrewThreadsSegment({
        title: `Crew (${members.length})`,
        ariaLabel: `${members.length} crew threads — jump to thread`,
        members,
        currentThreadId: threadId,
        onNavigate,
      }),
    );
  }

  if (showOverview) {
    segments.push({
      owner: "captain",
      slot: "action",
      priority: CAPTAIN_SEGMENT_PRIORITY,
      glyph: { kind: "icon", name: "LayoutList", tone: "muted" },
      label: "Overview",
      tone: "muted",
      ariaLabel: "Open Captain Overview",
      title: "Open Captain Overview",
      testId: "captain-hb-overview",
      onClick: onOpenOverview,
    });
  }
  return segments;
}

function buildCaptainSegments(args: {
  readonly mode: "captain" | "crew";
  readonly captainId: string;
  readonly threadId: string;
  readonly roster: CrewRoster | undefined;
  readonly errorMessage: string | null;
  readonly retrying: boolean;
  readonly showOverview: boolean;
  readonly onNavigate: (threadId: string, split?: boolean) => void;
  readonly onOpenOverview: () => void;
  readonly onRetry: () => void;
}): readonly HeaderBarSegment[] {
  const { mode, captainId, threadId, roster, errorMessage, retrying, showOverview, onNavigate } =
    args;
  if (roster === undefined) {
    if (errorMessage === null) return EMPTY_SEGMENTS;
    return buildDegradedSegments({
      mode,
      captainId,
      errorMessage,
      retrying,
      onNavigate,
      onRetry: args.onRetry,
    });
  }
  if (mode === "crew") return buildCrewSegments(roster, threadId, onNavigate);
  return buildCaptainThreadSegments({
    roster,
    threadId,
    showOverview,
    onNavigate,
    onOpenOverview: args.onOpenOverview,
  });
}

/**
 * Resolves whether this thread is a live Captain, crew of a live Captain, or
 * unrelated, and publishes compact statusbar segments to `@bb-plugins/header-bar`.
 */
export function CaptainHeaderRow({ threadId }: ExperimentalThreadHeaderRowProps) {
  const captains = useRpcQuery({ contract: captainContract, method: "captains", input: NO_INPUT });
  const captainIds = captains.data?.ids;
  const hasCaptains = captainIds !== undefined && captainIds.length > 0;
  const isCaptain = hasCaptains && captainIds.includes(threadId);
  const crewKeys = useMemo(() => [threadId], [threadId]);
  const crewOf = useRpcKeyedQuery({
    contract: captainContract,
    method: "crewOf",
    keys: crewKeys,
    enabled: hasCaptains && !isCaptain,
  });

  if (!hasCaptains) return null;
  if (isCaptain) {
    return <ResolvedHeaderPublisher mode="captain" captainId={threadId} threadId={threadId} />;
  }
  const crewCaptainId = crewOf.data?.[threadId] ?? null;
  if (crewCaptainId === null || !captainIds.includes(crewCaptainId)) return null;
  return <ResolvedHeaderPublisher mode="crew" captainId={crewCaptainId} threadId={threadId} />;
}

function ResolvedHeaderPublisher({
  mode,
  captainId,
  threadId,
}: {
  mode: "captain" | "crew";
  captainId: string;
  threadId: string;
}) {
  const input = useMemo(() => ({ captainId }), [captainId]);
  const {
    data: rosterData,
    error: rosterError,
    isFetching: rosterFetching,
    refetch: refetchRoster,
  } = useRpcQuery({ contract: captainContract, method: "crewRoster", input });
  const navigate = useBbNavigate();
  const panel = useAppPanel();
  const panelTabs = usePanelTabs();
  const compactViewport = useIsCompactViewport();
  const showOverview = mode === "captain" && (!panelTabs.open || compactViewport);

  const segments = useMemo(
    () =>
      buildCaptainSegments({
        mode,
        captainId,
        threadId,
        roster: rosterData,
        errorMessage: rosterError?.message ?? null,
        retrying: rosterFetching,
        showOverview,
        onNavigate: (targetId, split) =>
          split ? navigate.toThread(targetId, { split: true }) : navigate.toThread(targetId),
        onOpenOverview: () => {
          panel.openTab({ tab: CAPTAIN_OVERVIEW_TAB });
        },
        onRetry: () => {
          void refetchRoster();
        },
      }),
    [
      mode,
      captainId,
      threadId,
      rosterData,
      rosterError?.message,
      rosterFetching,
      refetchRoster,
      showOverview,
      navigate,
      panel,
    ],
  );

  usePublishHeaderBarSegments(threadId, "captain", segments);
  return null;
}
