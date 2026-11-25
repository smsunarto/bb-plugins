import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { eq } from "@tanstack/react-db";
import { type Label, type Task, type TaskStatus, type TaskThread } from "../../shared/contract.js";
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
import { STATUS_LABELS } from "../list/lib.js";
import { byManualOrder } from "../../shared/sort.js";
import { Button } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const DRAG_THRESHOLD_PX = 5;
const TOUCH_HOLD_MS = 400;
const SCROLL_EDGE_PX = 48;
const SCROLL_SPEED_PX_PER_MS = 0.8;

interface BoardCardMeta {
  workingThreads: readonly TaskThread[];
  attachmentCount: number;
  subDone: number;
  subTotal: number;
}

const NO_THREADS: readonly TaskThread[] = [];

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
    const metaFor = (taskId: string): BoardCardMeta => ({
      workingThreads: activeThreads.get(taskId) ?? NO_THREADS,
      attachmentCount: attachmentCounts.get(taskId) ?? 0,
      subDone: progress.get(taskId)?.done ?? 0,
      subTotal: progress.get(taskId)?.total ?? 0,
    });
    return { columns: groupColumns(tasks), metaFor };
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
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  width: number;
  overStatus: TaskStatus | null;
  dropIndex: number;
}

function WorkingAgentsChip({ threads }: { threads: readonly TaskThread[] }) {
  if (threads.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 font-medium text-success">
      <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-success" />
      <span className="truncate">
        {threads.length === 1 ? threads[0]!.presetName : `${threads.length} agents`}
      </span>
    </span>
  );
}

interface TaskCardProps {
  task: Task;
  labelsById: Map<string, Label>;
  meta: BoardCardMeta;
  ghost?: boolean;
  dragging?: boolean;
  cardRef?: (element: HTMLElement | null) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onClick?: () => void;
}

function TaskCard({
  task,
  labelsById,
  meta,
  ghost = false,
  dragging = false,
  cardRef,
  onPointerDown,
  onClick,
}: TaskCardProps) {
  const labels = task.labelIds
    .map((labelId) => labelsById.get(labelId))
    .filter((label): label is Label => label !== undefined);
  const Card = ghost ? "div" : "button";
  return (
    <Card
      ref={cardRef}
      type={ghost ? undefined : "button"}
      data-task-key={task.key}
      aria-hidden={ghost || undefined}
      aria-label={ghost ? undefined : `Open ${task.key}: ${task.title}`}
      onPointerDown={onPointerDown}
      onClick={onClick}
      className={cn(
        "min-h-19 shrink-0 rounded-md bg-surface-recessed-solid px-3 py-2.5 text-left select-none",
        ghost ? "shadow-md" : "cursor-pointer hover:bg-state-hover focus-visible:outline-ring",
        dragging && "opacity-40",
      )}
    >
      <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <PriorityIcon priority={task.priority} />
        <span className="font-mono tabular-nums">{task.key}</span>
        <WorkingAgentsChip threads={meta.workingThreads} />
      </span>
      <span className="mt-1 line-clamp-2 text-sm leading-snug font-medium">{task.title}</span>
      <span className="mt-2 flex flex-wrap items-center gap-2">
        {labels.map((label) => (
          <Badge
            key={label.id}
            variant="outline"
            className="h-5 gap-1 rounded-full px-1.5 py-0 text-2xs font-normal text-muted-foreground"
          >
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ backgroundColor: label.color }}
            />
            {label.name}
          </Badge>
        ))}
        {meta.subTotal > 0 ? (
          <span className="flex items-center gap-1 text-2xs text-muted-foreground">
            <Icon name="GitBranch" className="size-3" />
            {meta.subDone}/{meta.subTotal}
          </span>
        ) : null}
        {meta.attachmentCount > 0 ? (
          <Icon
            name="Paperclip"
            className="size-3 text-muted-foreground"
            aria-label={`${meta.attachmentCount} attachments`}
          />
        ) : null}
      </span>
    </Card>
  );
}

function BoardSkeleton() {
  return (
    <DelayedLoading>
      <div className="flex h-full items-start gap-3 overflow-x-auto p-4">
        {BOARD_STATUSES.map((status) => (
          <div key={status} className="flex w-58 shrink-0 flex-col gap-2 p-1">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-14 w-full rounded-lg" />
          </div>
        ))}
      </div>
    </DelayedLoading>
  );
}

interface BoardViewProps {
  projectId: string;
}

export function BoardView({ projectId }: BoardViewProps) {
  const navigation = useTasksNavigation();
  const openNewTask = useTasksUi((state) => state.openNewTask);
  const board = useBoardData(projectId);
  const columns = board.data?.columns;
  // Drag handlers outlive the render that started the drag; they read the
  // columns as last committed.
  const columnsRef = useRef(columns);
  useLayoutEffect(() => {
    columnsRef.current = columns;
  });

  const [drag, setDrag] = useState<DragState | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const columnRefs = useRef(new Map<TaskStatus, HTMLDivElement>());
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const suppressClickRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const findDropTarget = (
    x: number,
    y: number,
    draggedTaskId: string,
  ): { status: TaskStatus; index: number } | null => {
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
      if (x < rect.left - 6 || x > rect.right + 6) continue;
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
  };

  const commitDrop = (taskId: string, toStatus: TaskStatus, dropIndex: number) => {
    const current = columnsRef.current;
    if (!current) return;
    const neighbors = dropNeighborsForIndex(
      current[toStatus].map((task) => task.id),
      taskId,
      dropIndex,
    );
    // A card deleted mid-drag has nothing left to move.
    if (!tasksCollection.has(taskId)) return;
    // The card moves at once; a refused move puts it back.
    moveBoardTask({ taskId, status: toStatus, ...neighbors })
      .when("settled")
      .catch(() => {});
  };

  const handleCardPointerDown = (event: ReactPointerEvent<HTMLElement>, task: Task) => {
    if (event.button !== 0 || !event.isPrimary || dragCleanupRef.current) return;
    const { pointerId, currentTarget: card, clientX, clientY } = event;
    const touch = event.pointerType === "touch";
    const start = {
      x: clientX,
      y: clientY,
    };
    let cardRect: DOMRect | null = null;
    let hold: ReturnType<typeof setTimeout> | undefined;
    let moved = false;
    let scrollFrame: number | null = null;
    let lastFrame: number | null = null;
    let pointer = start;

    const updateDrag = (x: number, y: number) => {
      if (!cardRect) return;
      const target = findDropTarget(x, y, task.id);
      setDrag({
        taskId: task.id,
        x,
        y,
        offsetX: start.x - cardRect.left,
        offsetY: start.y - cardRect.top,
        width: cardRect.width,
        overStatus: target?.status ?? null,
        dropIndex: target?.index ?? 0,
      });
    };

    const scrollAtEdge = (now: number) => {
      scrollFrame = null;
      const board = boardRef.current;
      if (!board || !cardRect) return;
      const { left, right, top, bottom } = board.getBoundingClientRect();
      if (pointer.y < top || pointer.y > bottom || pointer.x < left || pointer.x > right) {
        lastFrame = null;
        return;
      }
      const leftPressure = Math.max(0, 1 - (pointer.x - left) / SCROLL_EDGE_PX);
      const rightPressure = Math.max(0, 1 - (right - pointer.x) / SCROLL_EDGE_PX);
      const direction = rightPressure - leftPressure;
      if (direction === 0) {
        lastFrame = null;
        return;
      }
      const previous = board.scrollLeft;
      const elapsed = lastFrame === null ? 16 : Math.min(now - lastFrame, 32);
      lastFrame = now;
      const step = direction * SCROLL_SPEED_PX_PER_MS * elapsed;
      // Scroll positions can be rounded to CSS pixels; even the edge of the zone must advance.
      board.scrollLeft = previous + Math.sign(step) * Math.max(1, Math.abs(step));
      if (board.scrollLeft === previous) {
        lastFrame = null;
        return;
      }
      updateDrag(pointer.x, pointer.y);
      scrollFrame = requestAnimationFrame(scrollAtEdge);
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const { clientX: x, clientY: y } = moveEvent;
      if (!moved && Math.hypot(x - start.x, y - start.y) < DRAG_THRESHOLD_PX) return;
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
      updateDrag(x, y);
      if (scrollFrame === null) scrollFrame = requestAnimationFrame(scrollAtEdge);
    };
    const finish = (upEvent: PointerEvent | null) => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      if (!cardRect) return;
      if (upEvent && moved) {
        const target = findDropTarget(upEvent.clientX, upEvent.clientY, task.id);
        if (target) commitDrop(task.id, target.status, target.index);
      }
      setDrag(null);
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    };
    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId === pointerId) finish(upEvent);
    };
    const onCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === pointerId) finish(null);
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
    dragCleanupRef.current = () => {
      clearTimeout(hold);
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
      card.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    if (touch) {
      card.addEventListener("touchmove", onTouchMove, { passive: false });
      hold = setTimeout(() => {
        cardRect = card.getBoundingClientRect();
        updateDrag(start.x, start.y);
      }, TOUCH_HOLD_MS);
    }
  };

  const openTask = (task: Task) => {
    if (suppressClickRef.current) return;
    navigation.go({ kind: "task", taskKey: task.key });
  };

  if (columns === undefined || board.data === undefined) {
    if (board.isError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <p>Failed to load the board: {tasksLoadError()}</p>
          <Button variant="outline" size="sm" onClick={board.retry}>
            Retry
          </Button>
        </div>
      );
    }
    return <BoardSkeleton />;
  }

  const { labelsById } = board;
  const { metaFor } = board.data;
  const ghostTask = drag
    ? Object.values(columns)
        .flat()
        .find((task) => task.id === drag.taskId)
    : undefined;

  const renderColumn = (status: TaskStatus) => {
    const cards = columns[status];
    const isDragOver = drag !== null && drag.overStatus === status;
    const remaining = drag ? cards.filter((task) => task.id !== drag.taskId) : cards;
    const indicatorBeforeTaskId = isDragOver ? (remaining[drag.dropIndex]?.id ?? null) : undefined;
    const indicator = (
      <div key="drop-indicator" className="h-0.5 shrink-0 rounded-full bg-primary" />
    );
    const children: ReactNode[] = [];
    for (const task of cards) {
      if (task.id === indicatorBeforeTaskId) children.push(indicator);
      children.push(
        <TaskCard
          key={task.id}
          task={task}
          labelsById={labelsById}
          meta={metaFor(task.id)}
          dragging={drag?.taskId === task.id}
          cardRef={(element) => {
            if (element) cardRefs.current.set(task.id, element);
            else cardRefs.current.delete(task.id);
          }}
          onPointerDown={(event) => handleCardPointerDown(event, task)}
          onClick={() => openTask(task)}
        />,
      );
    }
    if (indicatorBeforeTaskId === null) children.push(indicator);

    return (
      <div key={status} className="group flex max-h-full w-64 shrink-0 snap-start flex-col">
        <div className="flex min-h-10 items-center gap-2 px-2 text-xs font-medium">
          <StatusIcon status={status} />
          <span>{STATUS_LABELS[status]}</span>
          <Badge variant="count">{cards.length}</Badge>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-7 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-md:pointer-coarse:size-11 max-md:pointer-coarse:opacity-100"
            aria-label={`New ${STATUS_LABELS[status]} task`}
            onClick={() => openNewTask({ projectId, status })}
          >
            <Icon name="Plus" className="size-3.5" />
          </Button>
        </div>
        <div
          ref={(element) => {
            if (element) columnRefs.current.set(status, element);
            else columnRefs.current.delete(status);
          }}
          data-board-column={status}
          className={cn(
            "flex min-h-16 flex-col gap-1.5 overflow-y-auto rounded-md pb-2",
            isDragOver && "bg-surface-selected outline-2 outline-dashed outline-input",
          )}
        >
          {children}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={boardRef}
      className={cn(
        "flex h-full items-start gap-4 overflow-x-auto px-3 py-3 @md:px-6 max-md:pointer-coarse:pb-22",
        drag === null ? "snap-x" : "cursor-grabbing snap-none",
      )}
    >
      {visibleBoardStatuses(columns).map(renderColumn)}
      {drag && ghostTask ? (
        <div
          className="pointer-events-none fixed z-50"
          style={{
            left: drag.x - drag.offsetX,
            top: drag.y - drag.offsetY,
            width: drag.width,
          }}
        >
          <TaskCard task={ghostTask} labelsById={labelsById} meta={metaFor(ghostTask.id)} ghost />
        </div>
      ) : null}
    </div>
  );
}
