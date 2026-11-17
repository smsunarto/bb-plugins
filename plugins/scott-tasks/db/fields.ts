import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { FieldDefinition, TaskFieldValue } from "./types";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

export type FieldErrorCode =
  | "field_not_found"
  | "field_owned_by_other_plugin"
  | "field_value_not_allowed"
  | "field_value_in_use"
  | "task_not_found";

/** A refused field operation; callers map the code onto their own error surface. */
export class FieldError extends Error {
  constructor(
    readonly code: FieldErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FieldError";
  }
}

interface FieldDefinitionRow {
  key: string;
  owner_plugin_id: string;
  allowed_values: string;
  created_at: string;
  updated_at: string;
}

interface TaskFieldValueRow {
  task_id: string;
  field_key: string;
  value: string;
  head: string | null;
  written_at: string;
}

function definitionFromRow(row: FieldDefinitionRow): FieldDefinition {
  const values: unknown = JSON.parse(row.allowed_values);
  return {
    key: row.key,
    ownerPluginId: row.owner_plugin_id,
    values: Array.isArray(values) ? values.map(String) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function valueFromRow(row: TaskFieldValueRow): TaskFieldValue {
  return { key: row.field_key, value: row.value, head: row.head, writtenAt: row.written_at };
}

export interface SetTaskFieldInput {
  taskId: string;
  key: string;
  /** One of the field's values, or null to unset it. */
  value: string | null;
  head: string | null;
}

export interface SetTaskFieldResult {
  field: TaskFieldValue | null;
  /** False when the task already held this value and head; nothing was written. */
  changed: boolean;
  taskUpdatedAt: string;
}

/**
 * Owned custom fields. A field's owner is the only writer callers should admit;
 * the store enforces the value invariants and leaves caller identity to the API.
 */
export function createFieldStore(db: PluginDatabase, now: () => string) {
  function getFieldDefinition(key: string): FieldDefinition | undefined {
    const row = db
      .prepare<[string], FieldDefinitionRow>("SELECT * FROM field_definitions WHERE key = ?")
      .get(key);
    return row ? definitionFromRow(row) : undefined;
  }

  // Re-defining converges on the requested values; a value some task still holds
  // cannot be dropped, so every stored value stays one of the allowed ones.
  const defineFieldTransaction = db.transaction(
    (ownerPluginId: string, key: string, values: readonly string[]): FieldDefinition => {
      const current = getFieldDefinition(key);
      if (current && current.ownerPluginId !== ownerPluginId) {
        throw new FieldError(
          "field_owned_by_other_plugin",
          `field ${key} is owned by plugin ${current.ownerPluginId}`,
        );
      }
      if (current && JSON.stringify(current.values) === JSON.stringify(values)) return current;
      const allowed = new Set(values);
      const inUse = db
        .prepare<[string], { value: string }>(
          "SELECT DISTINCT value FROM task_field_values WHERE field_key = ? ORDER BY value",
        )
        .all(key)
        .map((row) => row.value)
        .filter((value) => !allowed.has(value));
      if (inUse.length > 0) {
        throw new FieldError(
          "field_value_in_use",
          `field ${key} still has tasks set to ${inUse.join(", ")}`,
        );
      }
      const timestamp = now();
      db.prepare<[string, string, string, string, string]>(
        `
        INSERT INTO field_definitions (key, owner_plugin_id, allowed_values, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET
          allowed_values = excluded.allowed_values,
          updated_at = excluded.updated_at
      `,
      ).run(key, ownerPluginId, JSON.stringify(values), timestamp, timestamp);
      const defined = getFieldDefinition(key);
      if (!defined) throw new Error(`field definition upsert failed: ${key}`);
      return defined;
    },
  );

  function defineField(
    ownerPluginId: string,
    key: string,
    values: readonly string[],
  ): FieldDefinition {
    return defineFieldTransaction(ownerPluginId, key, values);
  }

  function getTaskField(taskId: string, key: string): TaskFieldValue | undefined {
    const row = db
      .prepare<[string, string], TaskFieldValueRow>(
        "SELECT * FROM task_field_values WHERE task_id = ? AND field_key = ?",
      )
      .get(taskId, key);
    return row ? valueFromRow(row) : undefined;
  }

  // Writing a new value or head bumps the task's updated_at, so a verdict
  // reads as a change of its task.
  const setTaskFieldTransaction = db.transaction((input: SetTaskFieldInput): SetTaskFieldResult => {
    const task = db
      .prepare<[string], { updated_at: string }>("SELECT updated_at FROM tasks WHERE id = ?")
      .get(input.taskId);
    if (!task) throw new FieldError("task_not_found", `task not found: ${input.taskId}`);
    const definition = getFieldDefinition(input.key);
    if (!definition) throw new FieldError("field_not_found", `field not defined: ${input.key}`);
    if (input.value !== null && !definition.values.includes(input.value)) {
      throw new FieldError(
        "field_value_not_allowed",
        `field ${input.key} accepts ${definition.values.join(", ")}, not ${input.value}`,
      );
    }

    const current = getTaskField(input.taskId, input.key) ?? null;
    const unchanged =
      input.value === null
        ? current === null
        : current !== null && current.value === input.value && current.head === input.head;
    if (unchanged) return { field: current, changed: false, taskUpdatedAt: task.updated_at };

    const timestamp = now();
    if (input.value === null) {
      db.prepare<[string, string]>(
        "DELETE FROM task_field_values WHERE task_id = ? AND field_key = ?",
      ).run(input.taskId, input.key);
    } else {
      db.prepare<[string, string, string, string | null, string]>(
        `
        INSERT INTO task_field_values (task_id, field_key, value, head, written_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (task_id, field_key) DO UPDATE SET
          value = excluded.value,
          head = excluded.head,
          written_at = excluded.written_at
      `,
      ).run(input.taskId, input.key, input.value, input.head, timestamp);
    }
    db.prepare<[string, string]>("UPDATE tasks SET updated_at = ? WHERE id = ?").run(
      timestamp,
      input.taskId,
    );
    return {
      field: getTaskField(input.taskId, input.key) ?? null,
      changed: true,
      taskUpdatedAt: timestamp,
    };
  });

  function setTaskField(input: SetTaskFieldInput): SetTaskFieldResult {
    return setTaskFieldTransaction(input);
  }

  function listTaskFields(taskIds: readonly string[]): Map<string, TaskFieldValue[]> {
    const byTask = new Map<string, TaskFieldValue[]>(taskIds.map((taskId) => [taskId, []]));
    for (let offset = 0; offset < taskIds.length; offset += 500) {
      const ids = taskIds.slice(offset, offset + 500);
      if (ids.length === 0) continue;
      const rows = db
        .prepare<string[], TaskFieldValueRow>(
          `
          SELECT * FROM task_field_values
          WHERE task_id IN (${ids.map(() => "?").join(", ")})
          ORDER BY task_id, field_key
        `,
        )
        .all(...ids);
      for (const row of rows) byTask.get(row.task_id)?.push(valueFromRow(row));
    }
    return byTask;
  }

  return { defineField, getFieldDefinition, getTaskField, setTaskField, listTaskFields };
}
