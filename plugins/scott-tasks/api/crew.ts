import {
  experimental_PluginRpcRefusal,
  type BbPluginApi,
  type ExperimentalPluginRpcCaller,
  type ExperimentalPluginRpcHandlersWithContext,
} from "@get-bb/plugin-sdk";
import { FieldError, type FieldErrorCode } from "../db";
import { crewRpcContract } from "../shared/crew-contract";
import { publishTasksChanged, type TasksApiStore } from ".";

const REFUSAL_CODES: Record<FieldErrorCode, experimental_PluginRpcRefusal["code"]> = {
  field_not_found: "not_found",
  task_not_found: "not_found",
  field_owned_by_other_plugin: "forbidden",
  field_value_not_allowed: "invalid",
  field_value_in_use: "conflict",
};

function refuse(error: unknown): never {
  if (error instanceof FieldError) {
    throw new experimental_PluginRpcRefusal({
      code: REFUSAL_CODES[error.code],
      message: `${error.code}: ${error.message}`,
    });
  }
  throw error;
}

/** The calling plugin's id; app, CLI and agent callers are refused. */
function requirePluginCaller(caller: ExperimentalPluginRpcCaller, action: string): string {
  if (caller.kind === "plugin") return caller.pluginId;
  throw new experimental_PluginRpcRefusal({
    code: "forbidden",
    message: `plugin_caller_required: only a plugin can ${action}, through bb.sdk.plugins.callRpc`,
  });
}

export function crewHandlers(
  bb: BbPluginApi,
  store: TasksApiStore,
): ExperimentalPluginRpcHandlersWithContext<typeof crewRpcContract> {
  return {
    defineField(input, { experimental_caller }) {
      const owner = requirePluginCaller(experimental_caller, "define a field");
      try {
        return { field: store.tasks.defineField(owner, input.key, input.values) };
      } catch (error) {
        refuse(error);
      }
    },

    setField(input, { experimental_caller }) {
      const caller = requirePluginCaller(experimental_caller, "set a field");
      const definition = store.tasks.getFieldDefinition(input.key);
      if (definition && definition.ownerPluginId !== caller) {
        throw new experimental_PluginRpcRefusal({
          code: "forbidden",
          message: `field_owned_by_other_plugin: field ${input.key} is owned by plugin ${definition.ownerPluginId}`,
        });
      }
      try {
        const result = store.tasks.setTaskField({
          taskId: input.taskId,
          key: input.key,
          value: input.value,
          head: input.head,
        });
        if (result.changed) {
          const task = store.tasks.getTask(input.taskId);
          if (task) publishTasksChanged(bb, task.id, task.projectId);
        }
        return { field: result.field, taskUpdatedAt: result.taskUpdatedAt };
      } catch (error) {
        refuse(error);
      }
    },

    taskFields(input) {
      const ids = [...new Set(input.taskIds)].filter((id) => store.tasks.getTask(id) !== undefined);
      const fields = store.tasks.listTaskFields(ids);
      return { tasks: ids.map((taskId) => ({ taskId, fields: fields.get(taskId) ?? [] })) };
    },

    crewSnapshot(input) {
      const changedSince =
        input.changedSince === undefined ? null : new Date(input.changedSince).toISOString();
      return { rows: store.tasks.crewSnapshot(input.threadIds, changedSince) };
    },
  };
}

export function registerCrewApi(bb: BbPluginApi, store: TasksApiStore): void {
  bb.rpc.register(crewRpcContract, crewHandlers(bb, store));
}
