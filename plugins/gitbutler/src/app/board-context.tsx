import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { cn } from "./lib/utils.ts";

/*
 * What the parts of one board share: whether the board on screen has been
 * read since the panel opened, the status line over the foot of the board,
 * and where the focus goes when a write takes a card away.
 *
 * Two DOM attributes tie the focus to the board's markup:
 * - every BranchName button carries `data-branch-name={name}`
 * - the header's Refresh button carries `data-board-refresh`
 */

/**
 * Which workspace a board was read from: its environment, and the repository
 * the reader's choice resolved to. Two threads on one environment, or the
 * default repository and the same one chosen by name, are one workspace.
 */
export type WorkspaceIdentity = { environmentId: string; repositoryKey: string | null };

type Target = {
  threadId: string;
  repositoryKey?: string | undefined;
  /** The workspace of the board on screen. Absent or null before one is read. */
  workspace?: WorkspaceIdentity | null | undefined;
};

/**
 * The mutation key of every `but` write to one workspace. Writes to the same
 * workspace rewrite the same branches, so the panel runs one at a time, and
 * every write control asks this key whether another is running.
 */
export function butWriteKey(target: Target) {
  const { workspace } = target;
  return workspace
    ? (["but-write", "environment", workspace.environmentId, workspace.repositoryKey] as const)
    : (["but-write", "thread", target.threadId, target.repositoryKey ?? null] as const);
}

/** Whether a `but` write to this workspace is running, from any card or the header. */
export function useWriteBusy(target: Target): boolean {
  return useIsMutating({ mutationKey: butWriteKey(target) }, pluginQueryClient) > 0;
}

// Long enough to read a short line, short enough not to be mistaken for state.
const STATUS_MS = 3_000;
const FADE_MS = 150;

export type StatusMessage = { id: number; text: string; leaving: boolean };
export type TransientStatus = {
  message: StatusMessage | null;
  announce: (text: string) => void;
};

/**
 * A line that says what just happened, then clears itself. A new line
 * replaces the old one and starts the clock again.
 */
export function useTransientStatus(): TransientStatus {
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const timers = useRef<number[]>([]);
  const lastId = useRef(0);
  useEffect(() => {
    const pending = timers;
    return () => {
      for (const timer of pending.current) window.clearTimeout(timer);
    };
  }, []);
  const announce = useCallback((text: string) => {
    for (const timer of timers.current) window.clearTimeout(timer);
    lastId.current += 1;
    const id = lastId.current;
    setMessage({ id, text, leaving: false });
    timers.current = [
      window.setTimeout(
        () => setMessage((current) => (current ? { ...current, leaving: true } : null)),
        STATUS_MS - FADE_MS,
      ),
      window.setTimeout(() => setMessage(null), STATUS_MS),
    ];
  }, []);
  return useMemo(() => ({ message, announce }), [message, announce]);
}

const BRANCH_NAME = "[data-branch-name]";

function branchButtons(root: ParentNode): Map<string, HTMLElement> {
  const buttons = new Map<string, HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>(BRANCH_NAME)) {
    const name = element.dataset.branchName;
    if (name !== undefined && !buttons.has(name)) buttons.set(name, element);
  }
  return buttons;
}

/** The branch to focus once `removed` is gone: the next one in board order, else the one before. */
function successor(order: readonly string[], removed: string, remaining: ReadonlySet<string>) {
  const index = order.indexOf(removed);
  return (
    order.slice(index + 1).find((name) => remaining.has(name)) ??
    order
      .slice(0, Math.max(index, 0))
      .reverse()
      .find((name) => remaining.has(name))
  );
}

// A write reports back after the board has been read again, which takes a
// second or so. A card still there after this was not removed.
const REMOVAL_WAIT_MS = 3_000;

/** Whether the focus fell to the page, rather than the reader having moved it on. */
function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

type FocusRequest = {
  /** A removed branch, whose neighbour takes the focus, or a renamed one, which keeps it. */
  kind: "removed" | "renamed";
  branchName: string;
  order: string[];
  until: number;
};

/**
 * Delete and Land take their card away, and the browser drops the focus to
 * the page with it. This puts it on the next branch's name instead, or on
 * Refresh when no branch is left. Renaming a stack's bottom branch redraws
 * the whole stack, which drops the focus too, and the new name takes it.
 *
 * A write can report back before the board redraws or after it, so the
 * board's branch order is watched all along: a card already gone when asked
 * still has the neighbours it had.
 */
function useWriteFocus(root: RefObject<HTMLElement | null>) {
  const orders = useRef<{ now: string[]; before: string[] }>({ now: [], before: [] });
  const request = useRef<FocusRequest | null>(null);

  const settle = useCallback(() => {
    const board = root.current;
    const asked = request.current;
    if (!board || !asked) return;
    if (Date.now() > asked.until) {
      request.current = null;
      return;
    }
    const buttons = branchButtons(board);
    if (asked.kind === "renamed") {
      const renamed = buttons.get(asked.branchName);
      if (!renamed) return;
      request.current = null;
      if (focusLost()) renamed.focus();
      return;
    }
    if (buttons.has(asked.branchName)) return;
    request.current = null;
    // A reader who moved on while the write ran keeps the focus they chose.
    if (!focusLost()) return;
    const next = successor(asked.order, asked.branchName, new Set(buttons.keys()));
    const target =
      next === undefined
        ? board.querySelector<HTMLElement>("[data-board-refresh]")
        : buttons.get(next);
    target?.focus();
  }, [root]);

  useEffect(() => {
    const board = root.current;
    if (!board) return;
    orders.current = { now: [...branchButtons(board).keys()], before: [] };
    const observer = new MutationObserver(() => {
      const names = [...branchButtons(board).keys()];
      const { now } = orders.current;
      if (names.join("\n") !== now.join("\n")) orders.current = { now: names, before: now };
      settle();
    });
    observer.observe(board, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-branch-name"],
    });
    return () => {
      observer.disconnect();
      request.current = null;
    };
  }, [root, settle]);

  return useCallback(
    (kind: FocusRequest["kind"], branchName: string) => {
      const board = root.current;
      if (!board) return;
      const { now, before } = orders.current;
      const order =
        [[...branchButtons(board).keys()], now, before].find((names) =>
          names.includes(branchName),
        ) ?? [];
      request.current = { kind, branchName, order, until: Date.now() + REMOVAL_WAIT_MS };
      settle();
    },
    [root, settle],
  );
}

type Board = {
  live: boolean;
  workspace: WorkspaceIdentity | null;
  announce: (text: string) => void;
  focusAfterWrite: (kind: FocusRequest["kind"], branchName: string) => void;
};

const BoardContext = createContext<Board>({
  live: true,
  workspace: null,
  announce: () => {},
  focusAfterWrite: () => {},
});
const StatusContext = createContext<StatusMessage | null>(null);

/**
 * Provides the board's shared state to everything under it.
 *
 * Pass `status` from a `useTransientStatus()` in the same component when that
 * component also announces, since it sits above this provider and
 * `useAnnounce()` cannot reach it there. Without it the provider keeps its own.
 */
export function BoardProvider({
  live,
  workspace,
  root,
  status,
  children,
}: {
  /** False while the board on screen came from storage and has not been read again. */
  live: boolean;
  /** The workspace of the board on screen, or null before one is read. */
  workspace: WorkspaceIdentity | null;
  /** The element holding the branch cards and the Refresh button. */
  root: RefObject<HTMLElement | null>;
  status?: TransientStatus;
  children: ReactNode;
}) {
  const own = useTransientStatus();
  const { message, announce } = status ?? own;
  const focusAfterWrite = useWriteFocus(root);
  const board = useMemo(
    () => ({ live, workspace, announce, focusAfterWrite }),
    [live, workspace, announce, focusAfterWrite],
  );
  return (
    <BoardContext.Provider value={board}>
      <StatusContext.Provider value={message}>{children}</StatusContext.Provider>
    </BoardContext.Provider>
  );
}

/**
 * False while the board on screen came from storage and has not been read
 * again, so a write aimed at it may be aimed at a board hours old. True
 * outside a board.
 */
export function useBoardLive(): boolean {
  return useContext(BoardContext).live;
}

/** Says a line in the board's status line. Does nothing outside a board. */
export function useAnnounce(): (text: string) => void {
  return useContext(BoardContext).announce;
}

/** The workspace of the board on screen, or null before one is read and outside a board. */
export function useBoardWorkspace(): WorkspaceIdentity | null {
  return useContext(BoardContext).workspace;
}

/** What aims a write: the thread, its repository, and the environment the board was read in. */
export type WriteScope = {
  threadId: string;
  repositoryKey?: string | undefined;
  environmentId?: string;
};

/**
 * Aims a write at the workspace of the board on screen, not at whatever the
 * thread resolves to by the time it arrives. The server refuses it once the
 * thread has moved to another environment, where a same-named branch or a
 * conflict is someone else's. It names the repository the board resolved
 * to, so a default choice cannot drift to another repository, and the host
 * refuses it if that one has gone. Before a board is read it names only
 * what the reader chose.
 */
export function writeScope(
  target: { threadId: string; repositoryKey?: string | undefined },
  workspace: WorkspaceIdentity | null,
): WriteScope {
  if (!workspace) return { threadId: target.threadId, repositoryKey: target.repositoryKey };
  return {
    threadId: target.threadId,
    repositoryKey: workspace.repositoryKey ?? target.repositoryKey,
    environmentId: workspace.environmentId,
  };
}

/** Whether two writes were aimed at the same workspace. */
export function sameScope(a: WriteScope, b: WriteScope): boolean {
  return (
    a.threadId === b.threadId &&
    a.repositoryKey === b.repositoryKey &&
    a.environmentId === b.environmentId
  );
}

/**
 * The repository the board on screen is in, when the environment holds more
 * than one: what an agent asked about it needs told. Null for an
 * environment that is one repository, and outside a board.
 */
export function useBoardRepository(): string | null {
  const key = useContext(BoardContext).workspace?.repositoryKey ?? null;
  return key === "." ? null : key;
}

/**
 * Asks for the focus to follow a write that redraws a branch's card. Once a
 * removed branch's card is gone, it moves to the next branch's name or to
 * Refresh. Once a renamed branch's card is drawn, its new name takes it back
 * if the redraw dropped it. Does nothing outside a board.
 */
export function useFocusAfterWrite(): (kind: "removed" | "renamed", branchName: string) => void {
  return useContext(BoardContext).focusAfterWrite;
}

/**
 * The board's status line. The live region is always mounted, so a screen
 * reader hears the first line too, and it takes no room while it is empty.
 */
export function StatusLine({ className }: { className?: string }) {
  const message = useContext(StatusContext);
  return (
    <output
      aria-live="polite"
      className={
        message
          ? cn(
              "flex items-center gap-1.5 text-[11px] text-muted-foreground transition-opacity duration-150 motion-safe:animate-in motion-safe:fade-in-0",
              message.leaving && "opacity-0",
              className,
            )
          : "sr-only"
      }
    >
      {message ? (
        // Keyed, so the same line said twice is a new node and is read again.
        <Fragment key={message.id}>
          <Icon name="Check" className="size-3 shrink-0 text-success-foreground" aria-hidden />
          {message.text}
        </Fragment>
      ) : null}
    </output>
  );
}
