import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type {
  CrewSnapshotRow,
  ParentNotification,
  TaskFieldValue,
  TaskStatus,
  TaskThreadLiveStatus,
} from "./types";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

interface SnapshotRow {
  thread_id: string;
  preset_name: string;
  live_status: TaskThreadLiveStatus;
  live_status_changed_at: string;
  attached_at: string;
  updated_at: string;
  task_id: string;
  task_key: string;
  task_title: string;
  task_status: TaskStatus;
  task_status_changed_at: string;
  task_updated_at: string;
  parent_id: string | null;
  parent_key: string | null;
  parent_title: string | null;
  parent_status: TaskStatus | null;
  parent_status_changed_at: string | null;
  parent_updated_at: string | null;
  comment_id: string | null;
  comment_created_at: string | null;
}

/**
 * One read joining every attached row of the given threads with its task,
 * parent task, fields and the thread's latest notifying comment on that task.
 * Times are the ISO strings Tasks stores, so `changedSince` compares as text.
 */
export function createCrewSnapshotReader(
  db: PluginDatabase,
  deps: {
    listTaskFields(taskIds: readonly string[]): Map<string, TaskFieldValue[]>;
    getParentNotification(commentId: string): ParentNotification | undefined;
  },
) {
  return function crewSnapshot(
    threadIds: readonly string[],
    changedSince: string | null,
  ): CrewSnapshotRow[] {
    const ids = [...new Set(threadIds)];
    if (ids.length === 0) return [];
    const parameters: Record<string, string> = {};
    const names = ids.map((threadId, index) => {
      parameters[`thread${index}`] = threadId;
      return `@thread${index}`;
    });
    if (changedSince !== null) parameters.since = changedSince;
    const sinceFilter =
      changedSince === null
        ? ""
        : `AND (
            t.updated_at > @since
            OR tt.updated_at > @since
            OR pt.updated_at > @since
            OR EXISTS (SELECT 1 FROM comments cc WHERE cc.task_id = t.id AND cc.created_at > @since)
            OR EXISTS (
              SELECT 1 FROM comments cc
              JOIN comment_parent_notifications nn ON nn.comment_id = cc.id
              WHERE cc.task_id = t.id AND nn.updated_at > @since
            )
          )`;
    const rows = db
      .prepare<Record<string, string>, SnapshotRow>(
        `
        SELECT
          tt.thread_id, tt.preset_name, tt.live_status, tt.live_status_changed_at,
          tt.attached_at, tt.updated_at,
          t.id AS task_id, p.prefix || '-' || t.number AS task_key, t.title AS task_title,
          t.status AS task_status,
          COALESCE(t.status_changed_at, t.created_at) AS task_status_changed_at,
          t.updated_at AS task_updated_at,
          pt.id AS parent_id, pp.prefix || '-' || pt.number AS parent_key,
          pt.title AS parent_title, pt.status AS parent_status,
          COALESCE(pt.status_changed_at, pt.created_at) AS parent_status_changed_at,
          pt.updated_at AS parent_updated_at,
          lc.id AS comment_id, lc.created_at AS comment_created_at
        FROM task_threads tt
        JOIN tasks t ON t.id = tt.task_id
        JOIN projects p ON p.id = t.project_id
        LEFT JOIN tasks pt ON pt.id = t.parent_task_id
        LEFT JOIN projects pp ON pp.id = pt.project_id
        LEFT JOIN comments lc ON lc.id = (
          SELECT c.id FROM comments c
          JOIN comment_parent_notifications n ON n.comment_id = c.id
          WHERE c.task_id = tt.task_id AND c.thread_id = tt.thread_id
          ORDER BY c.created_at DESC, c.rowid DESC
          LIMIT 1
        )
        WHERE tt.thread_id IN (${names.join(", ")})
        ${sinceFilter}
        ORDER BY tt.thread_id, tt.attached_at, tt.id
      `,
      )
      .all(parameters);

    const fields = deps.listTaskFields([...new Set(rows.map((row) => row.task_id))]);
    return rows.map((row): CrewSnapshotRow => {
      const delivery =
        row.comment_id === null ? undefined : deps.getParentNotification(row.comment_id);
      return {
        threadId: row.thread_id,
        presetName: row.preset_name,
        liveStatus: row.live_status,
        liveStatusChangedAt: row.live_status_changed_at,
        attachedAt: row.attached_at,
        updatedAt: row.updated_at,
        task: {
          id: row.task_id,
          key: row.task_key,
          title: row.task_title,
          status: row.task_status,
          statusChangedAt: row.task_status_changed_at,
          updatedAt: row.task_updated_at,
        },
        parentTask:
          row.parent_id === null
            ? null
            : {
                id: row.parent_id,
                key: row.parent_key ?? "",
                title: row.parent_title ?? "",
                status: row.parent_status ?? "backlog",
                statusChangedAt: row.parent_status_changed_at ?? "",
                updatedAt: row.parent_updated_at ?? "",
              },
        fields: fields.get(row.task_id) ?? [],
        lastNotifyingComment:
          row.comment_id === null || row.comment_created_at === null || delivery === undefined
            ? null
            : { id: row.comment_id, createdAt: row.comment_created_at, delivery },
      };
    });
  };
}
