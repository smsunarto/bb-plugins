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
  type RefObject,
} from "react";
import { eq } from "@tanstack/react-db";
import { type Label, type Task, type TaskStatus, type TaskThread } from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import {
  attachmentCountsCollection,
  hasPendingWrites,
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

const NO_THREADS: readonly TaskThread[] = [];

interface SavedBoardScroll {
  boardLeft: number;
  columns: Partial<Record<TaskStatus, number>>;
}

const savedBoardScroll = new Map<string, SavedBoardScroll>();

/** Clear saved board scroll offsets between isolated tests. */
export function resetBoardScrollForTest(): void {
  savedBoardScroll.clear();
}

function writeBoardScroll(
  projectId: string,
  update: (entry: SavedBoardScroll) => SavedBoardScroll,
): void {
  const current = savedBoardScroll.get(projectId) ?? { boardLeft: 0, columns: {} };
  savedBoardScroll.set(projectId, update(current));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function edgeScrollStep(coord: number, start: number, end: number, elapsedMs: number): number {
  const startPressure =
    coord < start + SCROLL_EDGE_PX ? clamp01(1 - (coord - start) / SCROLL_EDGE_PX) : 0;
  const endPressure =
    coord > end - SCROLL_EDGE_PX ? clamp01(1 - (end - coord) / SCROLL_EDGE_PX) : 0;
  const direction = endPressure - startPressure;
  if (direction === 0) return 0;
  const raw = direction * SCROLL_SPEED_PX_PER_MS * elapsedMs;
  // Scroll positions can be rounded to CSS pixels; even the edge of the zone must advance.
  return Math.sign(raw) * Math.max(1, Math.abs(raw));
}

function isNearEdge(coord: number, start: number, end: number): boolean {
  return coord < start + SCROLL_EDGE_PX || coord > end - SCROLL_EDGE_PX;
}

function isPointInsideRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function isPointerNearScrollEdge(
  x: number,
  y: number,
  boardRect: DOMRect | null,
  hoveredRect: DOMRect | null,
): boolean {
  if (!boardRect || !isPointInsideRect(x, y, boardRect)) return false;
  if (isNearEdge(x, boardRect.left, boardRect.right)) return true;
  return hoveredRect !== null && isNearEdge(y, hoveredRect.top, hoveredRect.bottom);
}

function boardMoveAnnouncement(
  taskKey: string,
  fromStatus: TaskStatus,
  toStatus: TaskStatus,
  dropIndex: number,
  totalInTarget: number,
): string {
  const position = Math.max(1, Math.min(dropIndex + 1, totalInTarget));
  if (fromStatus === toStatus) {
    return `Moved ${taskKey} to position ${position} of ${totalInTarget} in ${STATUS_LABELS[toStatus]}`;
  }
  return `Moved ${taskKey} to ${STATUS_LABELS[toStatus]}, position ${position} of ${totalInTarget}`;
}

interface SubtaskProgress {
  done: number;
  total: number;
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
    const progress = new Map<string, SubtaskProgress>();
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
    return { columns: groupColumns(tasks), attachmentCounts, progress };
  }, [board.isReady, board.data]);
  const labelsById = useMemo(
    () =>
      new Map(
        (labels.data ?? [])
          .filter((label) => label.projectId === projectId)
          .map((label) => [label.id, label]),
      ),
    [labels.data, projectId],
  );
  return { data, activeThreads, labelsById, isError: board.isError, retry: board.retry };
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
  width: number;
  overStatus: TaskStatus | null;
  dropIndex: number;
}

interface DragPointer {
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
}

function WorkingAgentsChip({ threads }: { threads: readonly TaskThread[] }) {
  if (threads.length === 0) return null;
  const label = threads.length === 1 ? threads[0]!.presetName : `${threads.length} agents`;
  return (
    <span
      title={activeWorkLabel(threads)}
      className="flex min-w-0 items-center gap-1 font-medium text-foreground dark:text-success-foreground"
    >
      <StatusDot tone="success" size="sm" pulse />
      <span className="truncate">{label}</span>
    </span>
  );
}

function cardDescription(
  task: Task,
  labels: readonly Label[],
  workingThreads: readonly TaskThread[],
  subDone: number,
  subTotal: number,
  attachmentCount: number,
): string {
  const parts: string[] = [];
  if (task.priority !== "none") parts.push(`${PRIORITY_LABELS[task.priority]} priority`);
  if (workingThreads.length === 1) {
    parts.push(`${workingThreads[0]!.presetName}: ${activeWorkLabel(workingThreads)}`);
  } else if (workingThreads.length > 1) {
    parts.push(activeWorkLabel(workingThreads));
  }
  if (labels.length > 0) parts.push(`Labels: ${labels.map((label) => label.name).join(", ")}`);
  if (subTotal > 0) parts.push(`${subDone} of ${subTotal} sub-tasks done`);
  if (attachmentCount > 0) {
    parts.push(attachmentCount === 1 ? "1 attachment" : `${attachmentCount} attachments`);
  }
  return parts.join(". ");
}

function TaskCardFooter({
  labels,
  subDone,
  subTotal,
  attachmentCount,
}: {
  labels: readonly Label[];
  subDone: number;
  subTotal: number;
  attachmentCount: number;
}) {
  const { visible: visibleLabels, hidden: hiddenLabels } = partitionLabels(
    labels,
    MAX_VISIBLE_CARD_LABELS,
  );
  const hasCounts = subTotal > 0 || attachmentCount > 0;
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
          {subTotal > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Icon name="GitBranch" className="size-3" aria-hidden />
              {subDone}/{subTotal}
            </span>
          ) : null}
          {attachmentCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <Icon name="Paperclip" className="size-3" aria-hidden />
              {attachmentCount}
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
  workingThreads: readonly TaskThread[];
  attachmentCount: number;
  subDone: number;
  subTotal: number;
  ghost?: boolean;
  dragging?: boolean;
  registerCard?: (taskId: string, element: HTMLElement | null) => void;
  onCardPointerDown?: (event: ReactPointerEvent<HTMLElement>, task: Task) => void;
  onCardClick?: (task: Task) => void;
  onCardKeyDown?: (event: ReactKeyboardEvent<HTMLElement>, task: Task) => void;
}

const TaskCard = memo(function TaskCard({
  task,
  labelsById,
  workingThreads,
  attachmentCount,
  subDone,
  subTotal,
  ghost = false,
  dragging = false,
  registerCard,
  onCardPointerDown,
  onCardClick,
  onCardKeyDown,
}: TaskCardProps) {
  const descId = useId();
  const setRef = useCallback(
    (element: HTMLElement | null) => {
      registerCard?.(task.id, element);
    },
    [registerCard, task.id],
  );
  const labels = task.labelIds
    .map((labelId) => labelsById.get(labelId))
    .filter((label): label is Label => label !== undefined);
  const description = ghost
    ? ""
    : cardDescription(task, labels, workingThreads, subDone, subTotal, attachmentCount);
  const pending = !ghost && hasPendingWrites(task);
  const cardSurfaceClass = ghost
    ? "border-border bg-surface-raised-solid shadow-lg"
    : "cursor-pointer border-border-hairline bg-surface-recessed-solid hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary group-data-[dragging]/board:cursor-grabbing";
  const content = (
    <>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <PriorityIcon priority={task.priority} />
        <span className="shrink-0 whitespace-nowrap font-mono tabular-nums">{task.key}</span>
        <WorkingAgentsChip threads={workingThreads} />
      </span>
      <span
        dir="auto"
        className="mt-1 line-clamp-2 wrap-anywhere text-start text-sm leading-snug font-medium text-foreground"
      >
        {task.title}
      </span>
      <TaskCardFooter
        labels={labels}
        subDone={subDone}
        subTotal={subTotal}
        attachmentCount={attachmentCount}
      />
      {description ? (
        <span id={descId} className="sr-only">
          {description}
        </span>
      ) : null}
    </>
  );

  const baseClass = cn(
    "block w-full shrink-0 rounded-md border px-3 py-2.5 text-start select-none [-webkit-touch-callout:none]",
    cardSurfaceClass,
    dragging && "opacity-40",
    pending && !dragging && "border-dashed border-border",
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
      ref={setRef}
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
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading board"
        className="flex h-full items-stretch gap-4 overflow-x-auto px-3 py-3 @md:px-6"
      >
        {BOARD_STATUSES.map((status) => (
          <div key={status} className="flex h-full w-64 shrink-0 flex-col">
            <div className="flex min-h-10 items-center gap-2 px-2">
              <Skeleton className="size-3.5 rounded-full motion-reduce:animate-none" />
              <Skeleton className="h-3.5 w-16 motion-reduce:animate-none" />
              <Skeleton className="h-4 w-5 rounded-full motion-reduce:animate-none" />
            </div>
            <div className="flex flex-col gap-1.5 pt-1">
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

interface KeyboardMovePlan {
  toStatus: TaskStatus;
  dropIndex: number;
  totalInTarget: number;
}

function planKeyboardMove(
  columns: ColumnMap,
  statuses: readonly TaskStatus[],
  task: Task,
  key: string,
  horizontalStep: number,
): KeyboardMovePlan | null {
  const colIndex = statuses.indexOf(task.status);
  const colCards = columns[task.status];
  const rowIndex = colCards.findIndex((candidate) => candidate.id === task.id);
  if (colIndex === -1 || rowIndex === -1) return null;

  if (key === "ArrowLeft" || key === "ArrowRight") {
    const step = key === "ArrowRight" ? horizontalStep : -horizontalStep;
    const nextStatus = statuses[colIndex + step];
    if (!nextStatus) return null;
    const targetCards = columns[nextStatus];
    return {
      toStatus: nextStatus,
      dropIndex: Math.min(rowIndex, targetCards.length),
      totalInTarget: targetCards.length + 1,
    };
  }

  if (key === "ArrowUp" || key === "ArrowDown") {
    const delta = key === "ArrowDown" ? 1 : -1;
    const targetIndex = rowIndex + delta;
    if (targetIndex < 0 || targetIndex >= colCards.length) return null;
    return {
      toStatus: task.status,
      dropIndex: targetIndex,
      totalInTarget: colCards.length,
    };
  }
  return null;
}

function findKeyboardFocusTarget(
  columns: ColumnMap,
  statuses: readonly TaskStatus[],
  task: Task,
  key: string,
  horizontalStep: number,
): Task | undefined {
  const colIndex = statuses.indexOf(task.status);
  const colCards = columns[task.status];
  const rowIndex = colCards.findIndex((candidate) => candidate.id === task.id);
  if (colIndex === -1 || rowIndex === -1) return undefined;

  if (key === "ArrowDown") return colCards[rowIndex + 1];
  if (key === "ArrowUp") return colCards[rowIndex - 1];
  if (key !== "ArrowLeft" && key !== "ArrowRight") return undefined;

  const step = key === "ArrowRight" ? horizontalStep : -horizontalStep;
  for (let idx = colIndex + step; idx >= 0 && idx < statuses.length; idx += step) {
    const neighborCards = columns[statuses[idx]!];
    if (neighborCards.length > 0) {
      return neighborCards[Math.min(rowIndex, neighborCards.length - 1)];
    }
  }
  return undefined;
}

function useBoardScroll(
  projectId: string,
  columns: ColumnMap | undefined,
  boardRef: RefObject<HTMLDivElement | null>,
  columnRefs: RefObject<Map<TaskStatus, HTMLDivElement>>,
) {
  const restoredProjectRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!columns || restoredProjectRef.current === projectId) return;
    restoredProjectRef.current = projectId;
    const saved = savedBoardScroll.get(projectId);
    if (boardRef.current) boardRef.current.scrollLeft = saved?.boardLeft ?? 0;
    for (const status of visibleBoardStatuses(columns)) {
      const col = columnRefs.current.get(status);
      if (col) col.scrollTop = saved?.columns[status] ?? 0;
    }
  }, [boardRef, columnRefs, columns, projectId]);

  const onBoardScroll = useCallback(() => {
    if (restoredProjectRef.current !== projectId || !boardRef.current) return;
    const boardLeft = boardRef.current.scrollLeft;
    writeBoardScroll(projectId, (current) => ({ ...current, boardLeft }));
  }, [boardRef, projectId]);

  const columnScrollHandlers = useMemo(() => {
    const map = {} as Record<TaskStatus, () => void>;
    for (const status of [...BOARD_STATUSES, "canceled" as const]) {
      map[status] = () => {
        if (restoredProjectRef.current !== projectId) return;
        const col = columnRefs.current.get(status);
        if (!col) return;
        const top = col.scrollTop;
        writeBoardScroll(projectId, (current) => ({
          ...current,
          columns: { ...current.columns, [status]: top },
        }));
      };
    }
    return map;
  }, [columnRefs, projectId]);

  return { onBoardScroll, columnScrollHandlers };
}

interface BoardColumnProps {
  status: TaskStatus;
  headingId: string;
  cards: readonly Task[];
  labelsById: Map<string, Label>;
  activeThreads: ReadonlyMap<string, TaskThread[]>;
  attachmentCounts: ReadonlyMap<string, number>;
  progress: ReadonlyMap<string, SubtaskProgress>;
  drag: DragState | null;
  columnRef: (element: HTMLDivElement | null) => void;
  onScroll: () => void;
  onNewTask: () => void;
  registerCard: (taskId: string, element: HTMLElement | null) => void;
  onCardPointerDown: (event: ReactPointerEvent<HTMLElement>, task: Task) => void;
  onCardClick: (task: Task) => void;
  onCardKeyDown: (event: ReactKeyboardEvent<HTMLElement>, task: Task) => void;
}

const DROP_INDICATOR = (
  <div
    key="drop-indicator"
    data-drop-indicator=""
    aria-hidden
    className="pointer-events-none relative -my-0.75 h-0 shrink-0"
  >
    <div className="absolute inset-x-0 -top-px h-0.5 rounded-full bg-primary" />
  </div>
);

function BoardColumn({
  status,
  headingId,
  cards,
  labelsById,
  activeThreads,
  attachmentCounts,
  progress,
  drag,
  columnRef,
  onScroll,
  onNewTask,
  registerCard,
  onCardPointerDown,
  onCardClick,
  onCardKeyDown,
}: BoardColumnProps) {
  const isDragOver = drag !== null && drag.overStatus === status;
  const indicatorBeforeTaskId = isDragOver
    ? (cards.filter((task) => task.id !== drag.taskId)[drag.dropIndex]?.id ?? null)
    : undefined;
  const children: ReactNode[] = [];
  for (const task of cards) {
    if (task.id === indicatorBeforeTaskId) children.push(DROP_INDICATOR);
    const sub = progress.get(task.id);
    children.push(
      <div key={task.id} role="listitem" className="shrink-0">
        <TaskCard
          task={task}
          labelsById={labelsById}
          workingThreads={activeThreads.get(task.id) ?? NO_THREADS}
          attachmentCount={attachmentCounts.get(task.id) ?? 0}
          subDone={sub?.done ?? 0}
          subTotal={sub?.total ?? 0}
          dragging={drag?.taskId === task.id}
          registerCard={registerCard}
          onCardPointerDown={onCardPointerDown}
          onCardClick={onCardClick}
          onCardKeyDown={onCardKeyDown}
        />
      </div>,
    );
  }
  if (indicatorBeforeTaskId === null) children.push(DROP_INDICATOR);

  return (
    <section
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
          className="ms-auto opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100"
          aria-label={`New ${STATUS_LABELS[status]} task`}
          onClick={onNewTask}
        >
          <Icon name="Plus" className="size-3.5" />
        </CompactButton>
      </div>
      <div
        ref={columnRef}
        onScroll={onScroll}
        role="list"
        aria-label={`${STATUS_LABELS[status]}, ${cards.length} ${cards.length === 1 ? "task" : "tasks"}`}
        data-board-column={status}
        className={cn(
          "flex min-h-16 flex-1 flex-col gap-1.5 overflow-y-auto rounded-md pt-1 pb-2 max-md:pointer-coarse:pb-22",
          isDragOver &&
            "bg-surface-selected outline-2 -outline-offset-2 outline-dashed outline-primary",
        )}
      >
        {children}
      </div>
    </section>
  );
}

function BoardErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-1">
      <div role="alert" className="sr-only">
        Couldn't load board: {message}
      </div>
      <ViewEmptyState
        icon="AlertCircle"
        heading="Couldn't load board"
        description={message}
        action={
          <Button variant="outline" size="sm" className="pointer-coarse:h-11" onClick={onRetry}>
            Retry
          </Button>
        }
      />
    </div>
  );
}

function DragGhostOverlay({
  drag,
  labelsById,
  activeThreads,
  attachmentCounts,
  progress,
  setGhostRef,
}: {
  drag: DragState | null;
  labelsById: Map<string, Label>;
  activeThreads: ReadonlyMap<string, TaskThread[]>;
  attachmentCounts: ReadonlyMap<string, number>;
  progress: ReadonlyMap<string, SubtaskProgress>;
  setGhostRef: (element: HTMLDivElement | null) => void;
}) {
  if (!drag) return null;
  const ghostTask = tasksCollection.get(drag.taskId);
  if (!ghostTask) return null;
  const sub = progress.get(ghostTask.id);
  return (
    <div
      ref={setGhostRef}
      className="pointer-events-none fixed left-0 top-0 z-50"
      style={{ width: drag.width }}
    >
      <TaskCard
        task={ghostTask}
        labelsById={labelsById}
        workingThreads={activeThreads.get(ghostTask.id) ?? NO_THREADS}
        attachmentCount={attachmentCounts.get(ghostTask.id) ?? 0}
        subDone={sub?.done ?? 0}
        subTotal={sub?.total ?? 0}
        ghost
      />
    </div>
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
  const dragPointerRef = useRef<DragPointer | null>(null);
  const columnRefs = useRef(new Map<TaskStatus, HTMLDivElement>());
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const pendingFocusTaskIdRef = useRef<string | null>(null);
  const suppressClickRef = useRef(false);
  const suppressCleanupRef = useRef<(() => void) | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      suppressCleanupRef.current?.();
    },
    [],
  );

  const { onBoardScroll, columnScrollHandlers } = useBoardScroll(
    projectId,
    columns,
    boardRef,
    columnRefs,
  );

  const columnRefCallbacks = useMemo(() => {
    const map = {} as Record<TaskStatus, (element: HTMLDivElement | null) => void>;
    for (const status of [...BOARD_STATUSES, "canceled" as const]) {
      map[status] = (element) => {
        if (element) columnRefs.current.set(status, element);
        else columnRefs.current.delete(status);
      };
    }
    return map;
  }, []);

  // Keep focus attached to a card moved via keyboard (or restored on rollback).
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

  const setGhostRef = useCallback((element: HTMLDivElement | null) => {
    ghostRef.current = element;
    const pointer = dragPointerRef.current;
    if (element && pointer) {
      element.style.transform = `translate3d(${pointer.x - pointer.offsetX}px, ${pointer.y - pointer.offsetY}px, 0)`;
    }
  }, []);

  const armClickSuppression = useCallback((waitForPointerRelease: boolean) => {
    suppressCleanupRef.current?.();
    suppressClickRef.current = true;
    const clear = () => {
      suppressCleanupRef.current?.();
      suppressCleanupRef.current = null;
      suppressClickRef.current = false;
    };
    if (!waitForPointerRelease) {
      const timer = setTimeout(clear, 0);
      suppressCleanupRef.current = () => clearTimeout(timer);
      return;
    }
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const onPointerUp = () => {
      releaseTimer = setTimeout(clear, 0);
    };
    window.addEventListener("pointerup", onPointerUp, { once: true });
    suppressCleanupRef.current = () => {
      clearTimeout(releaseTimer);
      window.removeEventListener("pointerup", onPointerUp);
    };
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
    (
      taskId: string,
      toStatus: TaskStatus,
      dropIndex: number,
      options?: { keyboard?: boolean; taskKey?: string; fromStatus?: TaskStatus },
    ): { moved: boolean; totalInTarget: number } => {
      const current = columnsRef.current;
      if (!current) return { moved: false, totalInTarget: 0 };
      const targetColumn = current[toStatus];
      const currentIndex = targetColumn.findIndex((task) => task.id === taskId);
      // Dropping a card back into its own slot is a no-op; skip the RPC.
      if (currentIndex !== -1 && dropIndex === currentIndex) {
        return { moved: false, totalInTarget: targetColumn.length };
      }
      const neighbors = dropNeighborsForIndex(
        targetColumn.map((task) => task.id),
        taskId,
        dropIndex,
      );
      // A card deleted mid-drag has nothing left to move.
      if (!tasksCollection.has(taskId)) return { moved: false, totalInTarget: targetColumn.length };
      const totalInTarget = currentIndex === -1 ? targetColumn.length + 1 : targetColumn.length;
      // The card moves at once; a refused move rolls back, restores focus, and notifies.
      moveBoardTask({ taskId, status: toStatus, ...neighbors })
        .when("settled")
        .catch((error: unknown) => {
          onErrorRef.current?.(errorMessage(error));
          const shouldRestoreFocus =
            options?.keyboard ||
            document.activeElement === cardRefs.current.get(taskId) ||
            document.activeElement === document.body;
          if (shouldRestoreFocus) {
            pendingFocusTaskIdRef.current = taskId;
          }
          if (options?.taskKey && options.fromStatus) {
            setAnnouncement(
              `Could not move ${options.taskKey}; returned to ${STATUS_LABELS[options.fromStatus]}`,
            );
          }
        });
      return { moved: true, totalInTarget };
    },
    [],
  );

  const handleCardPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, task: Task) => {
      if (event.button !== 0 || !event.isPrimary || dragCleanupRef.current) return;
      suppressCleanupRef.current?.();
      suppressCleanupRef.current = null;
      suppressClickRef.current = false;

      const { pointerId, currentTarget: card, clientX, clientY } = event;
      const touch = event.pointerType === "touch";
      const start = { x: clientX, y: clientY };
      let active = true;
      let cardRect: DOMRect | null = null;
      let hold: ReturnType<typeof setTimeout> | undefined;
      let moved = false;
      let moveFrame: number | null = null;
      let scrollFrame: number | null = null;
      let lastFrame: number | null = null;
      let pointer = start;
      let activeOverStatus: TaskStatus | null = null;
      let activeDropIndex = 0;

      const writeGhostTransform = (x: number, y: number) => {
        if (!cardRect) return;
        const offsetX = start.x - cardRect.left;
        const offsetY = start.y - cardRect.top;
        dragPointerRef.current = { x, y, offsetX, offsetY };
        if (ghostRef.current) {
          ghostRef.current.style.transform = `translate3d(${x - offsetX}px, ${y - offsetY}px, 0)`;
        }
      };

      const scheduleEdgeScroll = () => {
        if (!active || scrollFrame !== null) return;
        scrollFrame = requestAnimationFrame(scrollAtEdge);
      };

      const syncDropState = (x: number, y: number, forceState = false) => {
        if (!active || !cardRect) return;
        // Read geometry BEFORE writing ghost transform to avoid read-after-write layout thrash.
        const target = findDropTarget(x, y, task.id);
        const boardRect = boardRef.current?.getBoundingClientRect() ?? null;
        const hoveredEl = target ? columnRefs.current.get(target.status) : undefined;
        const hoveredRect = hoveredEl?.getBoundingClientRect() ?? null;
        writeGhostTransform(x, y);

        const nextStatus = target?.status ?? null;
        const nextIndex = target?.index ?? 0;
        if (forceState || nextStatus !== activeOverStatus || nextIndex !== activeDropIndex) {
          activeOverStatus = nextStatus;
          activeDropIndex = nextIndex;
          setDrag({
            taskId: task.id,
            width: cardRect.width,
            overStatus: nextStatus,
            dropIndex: nextIndex,
          });
        }

        if (isPointerNearScrollEdge(x, y, boardRect, hoveredRect)) {
          scheduleEdgeScroll();
        }
      };

      function scrollAtEdge(now: number) {
        scrollFrame = null;
        if (!active) return;
        const boardEl = boardRef.current;
        if (!boardEl || !cardRect) return;
        const boardRect = boardEl.getBoundingClientRect();
        if (!isPointInsideRect(pointer.x, pointer.y, boardRect)) {
          lastFrame = null;
          return;
        }
        const hoveredColumn = activeOverStatus
          ? columnRefs.current.get(activeOverStatus)
          : undefined;
        const colRect = hoveredColumn?.getBoundingClientRect() ?? null;
        const elapsed = lastFrame === null ? 16 : Math.min(now - lastFrame, 32);

        // Compute both scroll deltas from batched reads before applying writes.
        const hStep = edgeScrollStep(pointer.x, boardRect.left, boardRect.right, elapsed);
        const vStep = colRect ? edgeScrollStep(pointer.y, colRect.top, colRect.bottom, elapsed) : 0;

        let scrolled = false;
        if (hStep !== 0) {
          const prevLeft = boardEl.scrollLeft;
          boardEl.scrollLeft = prevLeft + hStep;
          if (boardEl.scrollLeft !== prevLeft) scrolled = true;
        }
        if (vStep !== 0 && hoveredColumn) {
          const prevTop = hoveredColumn.scrollTop;
          hoveredColumn.scrollTop = prevTop + vStep;
          if (hoveredColumn.scrollTop !== prevTop) scrolled = true;
        }
        if (!scrolled) {
          lastFrame = null;
          return;
        }
        lastFrame = now;
        // syncDropState is the sole owner of scheduling the next edge-scroll RAF.
        syncDropState(pointer.x, pointer.y);
      }

      const flushMove = () => {
        moveFrame = null;
        if (!active) return;
        syncDropState(pointer.x, pointer.y);
      };

      const finish = (upEvent: PointerEvent | null, waitForRelease = false) => {
        if (!active) return;
        const hadDrag = cardRect !== null;
        dragCleanupRef.current?.();
        dragCleanupRef.current = null;
        dragPointerRef.current = null;
        if (!hadDrag) return;
        if (upEvent && moved) {
          const target = findDropTarget(upEvent.clientX, upEvent.clientY, task.id);
          if (target) {
            const result = commitDrop(task.id, target.status, target.index, {
              taskKey: task.key,
              fromStatus: task.status,
            });
            if (result.moved) {
              setAnnouncement(
                boardMoveAnnouncement(
                  task.key,
                  task.status,
                  target.status,
                  target.index,
                  result.totalInTarget,
                ),
              );
            }
          }
        }
        setDrag(null);
        armClickSuppression(waitForRelease);
      };

      const onMove = (moveEvent: PointerEvent) => {
        if (!active || moveEvent.pointerId !== pointerId) return;
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
        if (startingNow) {
          syncDropState(x, y, true);
        } else if (moveFrame === null) {
          moveFrame = requestAnimationFrame(flushMove);
        }
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId === pointerId) finish(upEvent);
      };
      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId === pointerId) finish(null);
      };
      const onBlur = () => {
        finish(null, true);
      };
      const onKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === "Escape" && cardRect) {
          keyEvent.preventDefault();
          finish(null, true);
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
        active = false;
        cardRect = null;
        clearTimeout(hold);
        if (moveFrame !== null) {
          cancelAnimationFrame(moveFrame);
          moveFrame = null;
        }
        if (scrollFrame !== null) {
          cancelAnimationFrame(scrollFrame);
          scrollFrame = null;
        }
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
          if (!active) return;
          cardRect = card.getBoundingClientRect();
          syncDropState(start.x, start.y, true);
        }, TOUCH_HOLD_MS);
      }
    },
    [armClickSuppression, commitDrop, findDropTarget],
  );

  const handleCardKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>, task: Task) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      const current = columnsRef.current;
      if (!current) return;
      const statuses = visibleBoardStatuses(current);
      const horizontalStep =
        boardRef.current && getComputedStyle(boardRef.current).direction === "rtl" ? -1 : 1;

      if (event.altKey) {
        const isArrow =
          event.key === "ArrowLeft" ||
          event.key === "ArrowRight" ||
          event.key === "ArrowUp" ||
          event.key === "ArrowDown";
        if (!isArrow) return;
        // Always prevent Alt+ArrowLeft/Right even at boundaries so browsers do not navigate Back/Forward.
        event.preventDefault();
        const plan = planKeyboardMove(current, statuses, task, event.key, horizontalStep);
        if (!plan) return;
        const result = commitDrop(task.id, plan.toStatus, plan.dropIndex, {
          keyboard: true,
          taskKey: task.key,
          fromStatus: task.status,
        });
        if (!result.moved) return;
        pendingFocusTaskIdRef.current = task.id;
        setAnnouncement(
          boardMoveAnnouncement(
            task.key,
            task.status,
            plan.toStatus,
            plan.dropIndex,
            result.totalInTarget,
          ),
        );
        return;
      }

      const target = findKeyboardFocusTarget(current, statuses, task, event.key, horizontalStep);
      if (!target) return;
      const element = cardRefs.current.get(target.id);
      if (!element) return;
      event.preventDefault();
      element.focus();
      element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    },
    [commitDrop],
  );

  const openTask = useCallback(
    (task: Task) => {
      if (suppressClickRef.current) {
        suppressCleanupRef.current?.();
        suppressCleanupRef.current = null;
        suppressClickRef.current = false;
        return;
      }
      navigation.go({ kind: "task", taskKey: task.key });
    },
    [navigation],
  );

  if (!columns || !board.data) {
    return board.isError ? (
      <BoardErrorState message={tasksLoadError()} onRetry={board.retry} />
    ) : (
      <BoardSkeleton />
    );
  }

  const { labelsById, activeThreads } = board;
  const { attachmentCounts, progress } = board.data;

  return (
    <div
      ref={boardRef}
      data-board-scroller=""
      data-dragging={drag !== null ? "" : undefined}
      onScroll={onBoardScroll}
      className={cn(
        "group/board flex h-full items-stretch gap-4 overflow-x-auto px-3 py-3 scroll-ps-3 @md:px-6 @md:scroll-ps-6",
        drag === null ? "snap-x" : "cursor-grabbing snap-none",
      )}
    >
      {visibleBoardStatuses(columns).map((status) => (
        <BoardColumn
          key={status}
          status={status}
          headingId={`${boardIdPrefix}-${status}`}
          cards={columns[status]}
          labelsById={labelsById}
          activeThreads={activeThreads}
          attachmentCounts={attachmentCounts}
          progress={progress}
          drag={drag}
          columnRef={columnRefCallbacks[status]}
          onScroll={columnScrollHandlers[status]}
          onNewTask={() => openNewTask({ projectId, status })}
          registerCard={registerCard}
          onCardPointerDown={handleCardPointerDown}
          onCardClick={openTask}
          onCardKeyDown={handleCardKeyDown}
        />
      ))}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
      <DragGhostOverlay
        drag={drag}
        labelsById={labelsById}
        activeThreads={activeThreads}
        attachmentCounts={attachmentCounts}
        progress={progress}
        setGhostRef={setGhostRef}
      />
    </div>
  );
}
