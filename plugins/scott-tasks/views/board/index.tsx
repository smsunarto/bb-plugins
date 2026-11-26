import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { eq } from "@tanstack/react-db";
import { type Label, type Task, type TaskStatus, type TaskThread } from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import {
  attachmentCountsCollection,
  moveBoardTask,
  tasksCollection,
} from "../../shell/collections.js";
import {
  tasksLoadError,
  useActiveThreads,
  useLabels,
  useTasksLiveQuery,
} from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { useTasksUi } from "../../shell/ui-store.js";
import {
  BOARD_STATUSES,
  dropIndexForPointer,
  dropNeighborsForIndex,
  visibleBoardStatuses,
} from "./drop-position.js";
import { PriorityIcon, StatusIcon } from "../list/icons.js";
import { activeWorkLabel, partitionLabels, PRIORITY_LABELS, STATUS_LABELS } from "../list/lib.js";
import { byManualOrder } from "../../shared/sort.js";
import { ViewEmptyState } from "../../components/empty-state.js";
import { Button, CompactButton } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const DRAG_THRESHOLD_PX = 5;
const TOUCH_HOLD_MS = 400;
const SCROLL_EDGE_PX = 48;
const SCROLL_SPEED_PX_PER_MS = 0.8;
const COLUMN_HIT_MARGIN_PX = 8;
const MAX_VISIBLE_CARD_LABELS = 3;

interface BoardCardMeta {
  workingThreads: readonly TaskThread[];
  attachmentCount: number;
  subDone: number;
  subTotal: number;
}

const NO_THREADS: readonly TaskThread[] = [];
const EMPTY_META: BoardCardMeta = {
  workingThreads: NO_THREADS,
  attachmentCount: 0,
  subDone: 0,
  subTotal: 0,
};

interface SavedBoardScroll {
  boardLeft: number;
  columns: Partial<Record<TaskStatus, number>>;
}

const savedBoardScroll = new Map<string, SavedBoardScroll>();

/** A card with an optimistic move the server has not confirmed yet. */
function hasPendingWrites(task: Task): boolean {
  return (task as { $hasPendingWrites?: boolean }).$hasPendingWrites === true;
}

/**
 * The project's tasks, each joined to its attachment count. Sub-tasks ride
 * along for the cards' progress; the counts load for exactly these cards.
 */
function useBoardData(projectId: string) {
  const board = useTasksLiveQuery(["board", projectId], (q) =>
    q
      .from({ task: tasksCollection })
      .where(({ task }) => eq(task.projectId, projectId))
      .leftJoin({ attachments: attachmentCountsCollection }, ({ task, attachments }) =>
        eq(task.id, attachments.taskId),
      ),
  );
  const activeThreads = useActiveThreads();
  const labels = useLabels();
  const data = useMemo(() => {
    if (!board.isReady) return undefined;
    const tasks: Task[] = [];
    const attachmentCounts = new Map<string, number>();
    const progress = new Map<string, { done: number; total: number }>();
    for (const { task, attachments } of board.data ?? []) {
      if (task.parentTaskId === null) {
        tasks.push(task);
        attachmentCounts.set(task.id, attachments?.count ?? 0);
        continue;
      }
      const entry = progress.get(task.parentTaskId) ?? { done: 0, total: 0 };
      entry.total += 1;
      if (task.status === "done") entry.done += 1;
      progress.set(task.parentTaskId, entry);
    }
    tasks.sort(byManualOrder);
    const metaById = new Map<string, BoardCardMeta>();
    for (const task of tasks) {
      const workingThreads = activeThreads.get(task.id) ?? NO_THREADS;
      const attachmentCount = attachmentCounts.get(task.id) ?? 0;
      const sub = progress.get(task.id);
      if (workingThreads.length === 0 && attachmentCount === 0 && sub === undefined) {
        metaById.set(task.id, EMPTY_META);
      } else {
        metaById.set(task.id, {
          workingThreads,
          attachmentCount,
          subDone: sub?.done ?? 0,
          subTotal: sub?.total ?? 0,
        });
      }
    }
    return { columns: groupColumns(tasks), metaById };
  }, [board.isReady, board.data, activeThreads]);
  const labelsById = useMemo(
    () =>
      new Map(
        (labels.data ?? [])
          .filter((label) => label.projectId === projectId)
          .map((label) => [label.id, label]),
      ),
    [labels.data, projectId],
  );
  return { data, labelsById, isError: board.isError, retry: board.retry };
}

type ColumnMap = Record<TaskStatus, Task[]>;

function groupColumns(tasks: readonly Task[]): ColumnMap {
  const columns: ColumnMap = {
    backlog: [],
    todo: [],
    in_progress: [],
    in_review: [],
    done: [],
    canceled: [],
  };
  for (const task of tasks) columns[task.status].push(task);
  return columns;
}

interface DragState {
  taskId: string;
  initialX: number;
  initialY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  overStatus: TaskStatus | null;
  dropIndex: number;
}

function WorkingAgentsChip({ threads }: { threads: readonly TaskThread[] }) {
  if (threads.length === 0) return null;
  const label = threads.length === 1 ? threads[0]!.presetName : `${threads.length} agents`;
  return (
    <span
      title={activeWorkLabel(threads)}
      className="flex min-w-0 items-center gap-1 font-medium text-success-foreground"
    >
      <StatusDot tone="success" size="sm" pulse />
      <span className="truncate">{label}</span>
    </span>
  );
}

function cardDescription(task: Task, labels: readonly Label[], meta: BoardCardMeta): string {
  const parts: string[] = [];
  if (task.priority !== "none") parts.push(`${PRIORITY_LABELS[task.priority]} priority`);
  if (meta.workingThreads.length > 0) parts.push(activeWorkLabel(meta.workingThreads));
  if (labels.length > 0) parts.push(`Labels: ${labels.map((label) => label.name).join(", ")}`);
  if (meta.subTotal > 0) parts.push(`${meta.subDone} of ${meta.subTotal} sub-tasks done`);
  if (meta.attachmentCount > 0) {
    parts.push(meta.attachmentCount === 1 ? "1 attachment" : `${meta.attachmentCount} attachments`);
  }
  return parts.join(". ");
}

function TaskCardFooter({ labels, meta }: { labels: readonly Label[]; meta: BoardCardMeta }) {
  const { visible: visibleLabels, hidden: hiddenLabels } = partitionLabels(
    labels,
    MAX_VISIBLE_CARD_LABELS,
  );
  const hasCounts = meta.subTotal > 0 || meta.attachmentCount > 0;
  if (labels.length === 0 && !hasCounts) return null;
  return (
    <span className="mt-2 flex flex-wrap items-center gap-1.5">
      {visibleLabels.map((label) => (
        <Badge key={label.id} variant="outline" className="max-w-full gap-1">
          <StatusDot tone="current" size="sm" style={{ color: label.color }} />
          <span className="truncate">{label.name}</span>
        </Badge>
      ))}
      {hiddenLabels.length > 0 ? (
        <Badge
          variant="outline"
          title={hiddenLabels.map((label) => label.name).join(", ")}
          className="tabular-nums text-muted-foreground"
        >
          +{hiddenLabels.length}
        </Badge>
      ) : null}
      {hasCounts ? (
        <span className="inline-flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
          {meta.subTotal > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Icon name="GitBranch" className="size-3" aria-hidden />
              {meta.subDone}/{meta.subTotal}
            </span>
          ) : null}
          {meta.attachmentCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <Icon name="Paperclip" className="size-3" aria-hidden />
              {meta.attachmentCount}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

interface TaskCardProps {
  task: Task;
  labelsById: Map<string, Label>;
  meta: BoardCardMeta;
  ghost?: boolean;
  dragging?: boolean;
  boardDragging?: boolean;
  registerCard?: (taskId: string, element: HTMLElement | null) => void;
  onCardPointerDown?: (event: ReactPointerEvent<HTMLElement>, task: Task) => void;
  onCardClick?: (task: Task) => void;
  onCardKeyDown?: (event: ReactKeyboardEvent<HTMLElement>, task: Task) => void;
}

const TaskCard = memo(function TaskCard({
  task,
  labelsById,
  meta,
  ghost = false,
  dragging = false,
  boardDragging = false,
  registerCard,
  onCardPointerDown,
  onCardClick,
  onCardKeyDown,
}: TaskCardProps) {
  const descId = useId();
  const labels = task.labelIds
    .map((labelId) => labelsById.get(labelId))
    .filter((label): label is Label => label !== undefined);
  const description = ghost ? "" : cardDescription(task, labels, meta);
  const pending = !ghost && hasPendingWrites(task);
  const cardSurfaceClass = ghost
    ? "border-border bg-surface-raised-solid shadow-lg"
    : cn(
        "border-border-hairline bg-surface-recessed-solid hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
        boardDragging ? "cursor-grabbing" : "cursor-pointer",
      );
  const content = (
    <>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <PriorityIcon priority={task.priority} />
        <span className="shrink-0 whitespace-nowrap font-mono tabular-nums">{task.key}</span>
        <WorkingAgentsChip threads={meta.workingThreads} />
      </span>
      <span
        dir="auto"
        className="mt-1 line-clamp-2 wrap-anywhere text-start text-sm leading-snug font-medium text-foreground"
      >
        {task.title}
      </span>
      <TaskCardFooter labels={labels} meta={meta} />
      {description ? (
        <span id={descId} className="sr-only">
          {description}
        </span>
      ) : null}
    </>
  );

  const baseClass = cn(
    "block w-full shrink-0 rounded-md border px-3 py-2.5 text-left select-none [-webkit-touch-callout:none]",
    cardSurfaceClass,
    dragging && "opacity-40",
    pending && !dragging && "opacity-70",
  );

  if (ghost) {
    return (
      <div data-task-key={task.key} aria-hidden className={baseClass}>
        {content}
      </div>
    );
  }

  return (
    <button
      ref={(element) => registerCard?.(task.id, element)}
      type="button"
      data-task-key={task.key}
      aria-busy={pending || undefined}
      aria-label={`Open ${task.key}: ${task.title}`}
      aria-describedby={description ? descId : undefined}
      onPointerDown={(event) => onCardPointerDown?.(event, task)}
      onClick={() => onCardClick?.(task)}
      onKeyDown={(event) => onCardKeyDown?.(event, task)}
      className={baseClass}
    >
      {content}
    </button>
  );
});

function BoardSkeleton() {
  return (
    <DelayedLoading>
      <div className="flex h-full items-stretch gap-4 overflow-x-auto px-3 py-3 @md:px-6">
        {BOARD_STATUSES.map((status) => (
          <div key={status} className="flex h-full w-64 shrink-0 flex-col">
            <div className="flex min-h-10 items-center gap-2 px-2">
              <Skeleton className="size-3.5 rounded-full motion-reduce:animate-none" />
              <Skeleton className="h-3.5 w-16 motion-reduce:animate-none" />
              <Skeleton className="h-4 w-5 rounded-full motion-reduce:animate-none" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-20 w-full rounded-md motion-reduce:animate-none" />
              <Skeleton className="h-20 w-full rounded-md motion-reduce:animate-none" />
              <Skeleton className="h-16 w-full rounded-md motion-reduce:animate-none" />
            </div>
          </div>
        ))}
      </div>
    </DelayedLoading>
  );
}

interface BoardViewProps {
  projectId: string;
  onError?: (message: string) => void;
}

export function BoardView({ projectId, onError }: BoardViewProps) {
  const navigation = useTasksNavigation();
  const openNewTask = useTasksUi((state) => state.openNewTask);
  const board = useBoardData(projectId);
  const columns = board.data?.columns;
  const boardIdPrefix = useId();
  // Drag and keyboard handlers outlive the render that started them; they read
  // the latest committed columns and error handler via refs.
  const columnsRef = useRef(columns);
  const onErrorRef = useRef(onError);
  useLayoutEffect(() => {
    columnsRef.current = columns;
    onErrorRef.current = onError;
  });

  const [drag, setDrag] = useState<DragState | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const boardRef = useRef<HTMLDivElement | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const columnRefs = useRef(new Map<TaskStatus, HTMLDivElement>());
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const pendingFocusTaskIdRef = useRef<string | null>(null);
  const suppressClickRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  // Restore saved board and column scroll offsets when returning from task detail.
  const restoredProjectRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!columns || restoredProjectRef.current === projectId) return;
    restoredProjectRef.current = projectId;
    const saved = savedBoardScroll.get(projectId);
    if (!saved) return;
    if (boardRef.current) boardRef.current.scrollLeft = saved.boardLeft;
    for (const [status, top] of Object.entries(saved.columns)) {
      const col = columnRefs.current.get(status as TaskStatus);
      if (col && top !== undefined) col.scrollTop = top;
    }
  }, [columns, projectId]);

  const captureScroll = useCallback(() => {
    const columnsScroll: Partial<Record<TaskStatus, number>> = {};
    for (const [status, el] of columnRefs.current.entries()) {
      if (el.scrollTop > 0) columnsScroll[status] = el.scrollTop;
    }
    savedBoardScroll.set(projectId, {
      boardLeft: boardRef.current?.scrollLeft ?? 0,
      columns: columnsScroll,
    });
  }, [projectId]);

  useEffect(() => captureScroll, [captureScroll]);

  // Keep focus attached to a card moved via keyboard across columns or positions.
  useLayoutEffect(() => {
    const taskId = pendingFocusTaskIdRef.current;
    if (!taskId) return;
    const element = cardRefs.current.get(taskId);
    if (!element) return;
    pendingFocusTaskIdRef.current = null;
    element.focus({ preventScroll: true });
    element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });

  const registerCard = useCallback((taskId: string, element: HTMLElement | null) => {
    if (element) cardRefs.current.set(taskId, element);
    else cardRefs.current.delete(taskId);
  }, []);

  const findDropTarget = useCallback(
    (x: number, y: number, draggedTaskId: string): { status: TaskStatus; index: number } | null => {
      const current = columnsRef.current;
      if (!current) return null;
      const boardRect = boardRef.current?.getBoundingClientRect();
      if (
        boardRect &&
        (y < boardRect.top - 24 ||
          y > boardRect.bottom + 24 ||
          x < boardRect.left ||
          x > boardRect.right)
      ) {
        return null;
      }
      for (const status of visibleBoardStatuses(current)) {
        const columnElement = columnRefs.current.get(status);
        if (!columnElement) continue;
        const rect = columnElement.getBoundingClientRect();
        if (x < rect.left - COLUMN_HIT_MARGIN_PX || x > rect.right + COLUMN_HIT_MARGIN_PX) continue;
        const centers = current[status]
          .filter((task) => task.id !== draggedTaskId)
          .map((task) => {
            const cardElement = cardRefs.current.get(task.id);
            if (!cardElement) return Number.NEGATIVE_INFINITY;
            const cardRect = cardElement.getBoundingClientRect();
            return cardRect.top + cardRect.height / 2;
          });
        return { status, index: dropIndexForPointer(centers, y) };
      }
      return null;
    },
    [],
  );

  const commitDrop = useCallback(
    (taskId: string, toStatus: TaskStatus, dropIndex: number): boolean => {
      const current = columnsRef.current;
      if (!current) return false;
      const targetColumn = current[toStatus];
      const currentIndex = targetColumn.findIndex((task) => task.id === taskId);
      // Dropping a card back into its own slot is a no-op; skip the RPC.
      if (currentIndex !== -1 && dropIndex === currentIndex) return false;
      const neighbors = dropNeighborsForIndex(
        targetColumn.map((task) => task.id),
        taskId,
        dropIndex,
      );
      // A card deleted mid-drag has nothing left to move.
      if (!tasksCollection.has(taskId)) return false;
      // The card moves at once; a refused move puts it back and notifies the user.
      moveBoardTask({ taskId, status: toStatus, ...neighbors })
        .when("settled")
        .catch((error: unknown) => {
          onErrorRef.current?.(errorMessage(error));
        });
      return true;
    },
    [],
  );

  const handleCardPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, task: Task) => {
      if (event.button !== 0 || !event.isPrimary || dragCleanupRef.current) return;
      const { pointerId, currentTarget: card, clientX, clientY } = event;
      const touch = event.pointerType === "touch";
      const start = { x: clientX, y: clientY };
      let cardRect: DOMRect | null = null;
      let hold: ReturnType<typeof setTimeout> | undefined;
      let moved = false;
      let scrollFrame: number | null = null;
      let lastFrame: number | null = null;
      let pointer = start;
      let activeOverStatus: TaskStatus | null = null;
      let activeDropIndex = 0;

      const positionGhost = (x: number, y: number) => {
        if (!cardRect || !ghostRef.current) return;
        const dx = x - (start.x - cardRect.left);
        const dy = y - (start.y - cardRect.top);
        ghostRef.current.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      };

      const updateDrag = (x: number, y: number, forceState = false) => {
        if (!cardRect) return;
        positionGhost(x, y);
        const target = findDropTarget(x, y, task.id);
        const nextStatus = target?.status ?? null;
        const nextIndex = target?.index ?? 0;
        if (!forceState && nextStatus === activeOverStatus && nextIndex === activeDropIndex) {
          return;
        }
        activeOverStatus = nextStatus;
        activeDropIndex = nextIndex;
        setDrag({
          taskId: task.id,
          initialX: x,
          initialY: y,
          offsetX: start.x - cardRect.left,
          offsetY: start.y - cardRect.top,
          width: cardRect.width,
          overStatus: nextStatus,
          dropIndex: nextIndex,
        });
      };

      const scrollAtEdge = (now: number) => {
        scrollFrame = null;
        const boardEl = boardRef.current;
        if (!boardEl || !cardRect) return;
        const { left, right, top, bottom } = boardEl.getBoundingClientRect();
        if (pointer.y < top || pointer.y > bottom || pointer.x < left || pointer.x > right) {
          lastFrame = null;
          return;
        }
        const elapsed = lastFrame === null ? 16 : Math.min(now - lastFrame, 32);
        let scrolled = false;

        // Horizontal board edge auto-scroll
        const leftPressure = Math.max(0, 1 - (pointer.x - left) / SCROLL_EDGE_PX);
        const rightPressure = Math.max(0, 1 - (right - pointer.x) / SCROLL_EDGE_PX);
        const horizontal = rightPressure - leftPressure;
        if (horizontal !== 0) {
          const previous = boardEl.scrollLeft;
          const step = horizontal * SCROLL_SPEED_PX_PER_MS * elapsed;
          // Scroll positions can be rounded to CSS pixels; even the edge of the zone must advance.
          boardEl.scrollLeft = previous + Math.sign(step) * Math.max(1, Math.abs(step));
          if (boardEl.scrollLeft !== previous) scrolled = true;
        }

        // Vertical auto-scroll inside the hovered column (e.g. 50+ card Backlog)
        const hoveredColumn = activeOverStatus
          ? columnRefs.current.get(activeOverStatus)
          : undefined;
        if (hoveredColumn) {
          const colRect = hoveredColumn.getBoundingClientRect();
          if (pointer.y >= colRect.top && pointer.y <= colRect.bottom) {
            const topPressure = Math.max(0, 1 - (pointer.y - colRect.top) / SCROLL_EDGE_PX);
            const bottomPressure = Math.max(0, 1 - (colRect.bottom - pointer.y) / SCROLL_EDGE_PX);
            const vertical = bottomPressure - topPressure;
            if (vertical !== 0) {
              const previousTop = hoveredColumn.scrollTop;
              const vStep = vertical * SCROLL_SPEED_PX_PER_MS * elapsed;
              hoveredColumn.scrollTop =
                previousTop + Math.sign(vStep) * Math.max(1, Math.abs(vStep));
              if (hoveredColumn.scrollTop !== previousTop) scrolled = true;
            }
          }
        }

        if (!scrolled) {
          lastFrame = null;
          return;
        }
        lastFrame = now;
        updateDrag(pointer.x, pointer.y);
        scrollFrame = requestAnimationFrame(scrollAtEdge);
      };

      const finish = (upEvent: PointerEvent | null) => {
        dragCleanupRef.current?.();
        dragCleanupRef.current = null;
        if (!cardRect) return;
        if (upEvent && moved) {
          const target = findDropTarget(upEvent.clientX, upEvent.clientY, task.id);
          if (target) {
            const changed = commitDrop(task.id, target.status, target.index);
            if (changed) {
              setAnnouncement(`Moved ${task.key} to ${STATUS_LABELS[target.status]}`);
            }
          }
        }
        setDrag(null);
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      };

      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        const { clientX: x, clientY: y } = moveEvent;
        if (!moved && Math.hypot(x - start.x, y - start.y) < DRAG_THRESHOLD_PX) return;
        const startingNow = !cardRect;
        if (!cardRect) {
          if (touch) {
            // A swipe before the hold completes belongs to native scrolling.
            finish(null);
            return;
          }
          cardRect = card.getBoundingClientRect();
        }
        moved = true;
        moveEvent.preventDefault();
        pointer = { x, y };
        updateDrag(x, y, startingNow);
        if (scrollFrame === null) scrollFrame = requestAnimationFrame(scrollAtEdge);
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId === pointerId) finish(upEvent);
      };
      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId === pointerId) finish(null);
      };
      const onBlur = () => {
        finish(null);
      };
      const onKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === "Escape" && cardRect) {
          keyEvent.preventDefault();
          finish(null);
        }
      };
      const onTouchMove = (moveEvent: TouchEvent) => {
        if (moveEvent.touches.length > 1) {
          finish(null);
        } else if (cardRect && moveEvent.cancelable) {
          // Prevent native scrolling only once a card has been picked up.
          moveEvent.preventDefault();
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onBlur);
      window.addEventListener("keydown", onKeyDown);
      dragCleanupRef.current = () => {
        clearTimeout(hold);
        if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
        card.removeEventListener("touchmove", onTouchMove);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("keydown", onKeyDown);
      };
      if (touch) {
        card.addEventListener("touchmove", onTouchMove, { passive: false });
        hold = setTimeout(() => {
          cardRect = card.getBoundingClientRect();
          updateDrag(start.x, start.y, true);
        }, TOUCH_HOLD_MS);
      }
    },
    [commitDrop, findDropTarget],
  );

  const handleCardKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>, task: Task) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      const current = columnsRef.current;
      if (!current) return;
      const statuses = visibleBoardStatuses(current);
      const colIndex = statuses.indexOf(task.status);
      if (colIndex === -1) return;
      const colCards = current[task.status];
      const rowIndex = colCards.findIndex((candidate) => candidate.id === task.id);
      if (rowIndex === -1) return;

      if (event.altKey) {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          const nextStatus = statuses[colIndex + (event.key === "ArrowRight" ? 1 : -1)];
          if (!nextStatus) return;
          event.preventDefault();
          const targetCards = current[nextStatus];
          const targetIndex = Math.min(rowIndex, targetCards.length);
          pendingFocusTaskIdRef.current = task.id;
          if (commitDrop(task.id, nextStatus, targetIndex)) {
            setAnnouncement(`Moved ${task.key} to ${STATUS_LABELS[nextStatus]}`);
          }
          return;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          const delta = event.key === "ArrowDown" ? 1 : -1;
          const targetIndex = rowIndex + delta;
          if (targetIndex < 0 || targetIndex >= colCards.length) return;
          event.preventDefault();
          pendingFocusTaskIdRef.current = task.id;
          if (commitDrop(task.id, task.status, targetIndex)) {
            setAnnouncement(
              `Moved ${task.key} ${delta < 0 ? "up" : "down"} in ${STATUS_LABELS[task.status]}`,
            );
          }
          return;
        }
        return;
      }

      const focusTask = (target: Task | undefined) => {
        if (!target) return;
        const element = cardRefs.current.get(target.id);
        if (!element) return;
        element.focus();
        element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      };

      if (event.key === "ArrowDown") {
        const next = colCards[rowIndex + 1];
        if (!next) return;
        event.preventDefault();
        focusTask(next);
      } else if (event.key === "ArrowUp") {
        const prev = colCards[rowIndex - 1];
        if (!prev) return;
        event.preventDefault();
        focusTask(prev);
      } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        const step = event.key === "ArrowRight" ? 1 : -1;
        for (let idx = colIndex + step; idx >= 0 && idx < statuses.length; idx += step) {
          const neighborCards = current[statuses[idx]!];
          if (neighborCards.length === 0) continue;
          event.preventDefault();
          focusTask(neighborCards[Math.min(rowIndex, neighborCards.length - 1)]);
          return;
        }
      }
    },
    [commitDrop],
  );

  const openTask = useCallback(
    (task: Task) => {
      if (suppressClickRef.current) return;
      captureScroll();
      navigation.go({ kind: "task", taskKey: task.key });
    },
    [captureScroll, navigation],
  );

  if (columns === undefined || board.data === undefined) {
    if (board.isError) {
      return (
        <div role="alert" className="flex h-full flex-1">
          <ViewEmptyState
            icon="AlertCircle"
            heading="Couldn't load board"
            description={tasksLoadError()}
            action={
              <Button variant="outline" size="sm" onClick={board.retry}>
                Retry
              </Button>
            }
          />
        </div>
      );
    }
    return <BoardSkeleton />;
  }

  const { labelsById } = board;
  const { metaById } = board.data;
  const ghostTask = drag
    ? Object.values(columns)
        .flat()
        .find((task) => task.id === drag.taskId)
    : undefined;

  const renderColumn = (status: TaskStatus) => {
    const cards = columns[status];
    const headingId = `${boardIdPrefix}-${status}`;
    const isDragOver = drag !== null && drag.overStatus === status;
    const remaining = drag ? cards.filter((task) => task.id !== drag.taskId) : cards;
    const indicatorBeforeTaskId = isDragOver ? (remaining[drag.dropIndex]?.id ?? null) : undefined;
    const indicator = (
      <div
        key="drop-indicator"
        aria-hidden
        className="pointer-events-none relative -my-0.75 h-0 shrink-0"
      >
        <div className="absolute inset-x-0 -top-px h-0.5 rounded-full bg-primary" />
      </div>
    );
    const children: ReactNode[] = [];
    for (const task of cards) {
      if (task.id === indicatorBeforeTaskId) children.push(indicator);
      children.push(
        <div key={task.id} role="listitem" className="shrink-0">
          <TaskCard
            task={task}
            labelsById={labelsById}
            meta={metaById.get(task.id) ?? EMPTY_META}
            dragging={drag?.taskId === task.id}
            boardDragging={drag !== null}
            registerCard={registerCard}
            onCardPointerDown={handleCardPointerDown}
            onCardClick={openTask}
            onCardKeyDown={handleCardKeyDown}
          />
        </div>,
      );
    }
    if (indicatorBeforeTaskId === null) children.push(indicator);

    return (
      <section
        key={status}
        aria-labelledby={headingId}
        className="group flex h-full min-h-0 w-64 shrink-0 snap-start flex-col"
      >
        <div className="flex min-h-10 shrink-0 items-center gap-2 px-2 text-xs font-medium">
          <StatusIcon status={status} />
          <h2 id={headingId} className="truncate">
            {STATUS_LABELS[status]}
          </h2>
          <Badge variant="count" aria-hidden>
            {cards.length}
          </Badge>
          <CompactButton
            variant="ghost"
            tone="muted"
            size="icon-sm"
            className="ml-auto opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-md:pointer-coarse:size-11 max-md:pointer-coarse:opacity-100"
            aria-label={`New ${STATUS_LABELS[status]} task`}
            onClick={() => openNewTask({ projectId, status })}
          >
            <Icon name="Plus" className="size-3.5" />
          </CompactButton>
        </div>
        <div
          ref={(element) => {
            if (element) columnRefs.current.set(status, element);
            else columnRefs.current.delete(status);
          }}
          role="list"
          aria-label={`${STATUS_LABELS[status]}, ${cards.length} ${cards.length === 1 ? "task" : "tasks"}`}
          data-board-column={status}
          className={cn(
            "flex min-h-16 flex-1 flex-col gap-1.5 overflow-y-auto rounded-md pb-2 max-md:pointer-coarse:pb-22",
            isDragOver &&
              "bg-surface-selected outline-2 -outline-offset-2 outline-dashed outline-primary",
          )}
        >
          {children}
        </div>
      </section>
    );
  };

  return (
    <div
      ref={boardRef}
      className={cn(
        "flex h-full items-stretch gap-4 overflow-x-auto px-3 py-3 scroll-pl-3 @md:px-6 @md:scroll-pl-6",
        drag === null ? "snap-x" : "cursor-grabbing snap-none",
      )}
    >
      {visibleBoardStatuses(columns).map(renderColumn)}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
      {drag && ghostTask ? (
        <div
          ref={ghostRef}
          className="pointer-events-none fixed left-0 top-0 z-50"
          style={{
            transform: `translate3d(${drag.initialX - drag.offsetX}px, ${drag.initialY - drag.offsetY}px, 0)`,
            width: drag.width,
          }}
        >
          <TaskCard
            task={ghostTask}
            labelsById={labelsById}
            meta={metaById.get(ghostTask.id) ?? EMPTY_META}
            ghost
          />
        </div>
      ) : null}
    </div>
  );
}
