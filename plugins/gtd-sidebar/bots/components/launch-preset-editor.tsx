import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_PermissionModePicker as PermissionModePicker,
} from "@get-bb/plugin-sdk/app";
import type { LaunchPreset } from "../lib/launch-preset";
import type { Dispatch, SetStateAction } from "react";

export function LaunchPresetEditor({
  value,
  onChange,
  hostId,
  disabled,
}: {
  value: LaunchPreset;
  onChange: Dispatch<SetStateAction<LaunchPreset>>;
  hostId: string;
  disabled: boolean;
}) {
  const execution = value.execution;
  const routing = hostId ? { kind: "host" as const, hostId } : undefined;
  return (
    <fieldset disabled={disabled} className="space-y-3 border-t border-border pt-3">
      <legend className="px-1 text-xs font-medium">New conversations</legend>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="accent-primary"
            checked={execution !== null}
            onChange={(event) =>
              onChange({
                ...value,
                execution: event.target.checked
                  ? { providerId: "", model: "", reasoningLevel: "medium", permissionMode: null }
                  : null,
              })
            }
          />
          Use a preferred model
        </label>
        {execution ? (
          <div className="space-y-2">
            <ProviderModelPicker
              value={execution}
              routing={routing}
              disabled={disabled || !hostId}
              className="h-8 max-w-full"
              onChange={(selection) =>
                onChange((current) =>
                  current.execution
                    ? {
                        ...current,
                        execution: {
                          ...selection,
                          permissionMode: current.execution.permissionMode,
                        },
                      }
                    : current,
                )
              }
            />
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={execution.permissionMode !== null}
                  disabled={disabled || !execution.providerId}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      execution: {
                        ...execution,
                        permissionMode: event.target.checked ? "accept-edits" : null,
                      },
                    })
                  }
                />
                Custom permissions
              </label>
              {execution.permissionMode !== null ? (
                <PermissionModePicker
                  providerId={execution.providerId}
                  value={execution.permissionMode}
                  routing={routing}
                  disabled={disabled || !hostId}
                  align="start"
                  className="h-7"
                  onChange={(permissionMode) =>
                    onChange((current) =>
                      current.execution?.providerId === execution.providerId &&
                      current.execution.permissionMode !== null
                        ? { ...current, execution: { ...current.execution, permissionMode } }
                        : current,
                    )
                  }
                />
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Use the project’s model and permissions.
          </p>
        )}
      </div>
      <label className="block space-y-1 text-xs font-medium text-muted-foreground">
        Project workspace
        <select
          aria-label="Project workspace"
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"
          value={value.workspace}
          onChange={(event) =>
            onChange({ ...value, workspace: event.target.value as LaunchPreset["workspace"] })
          }
        >
          <option value="checkout">Project checkout</option>
          <option value="worktree">Fresh worktree</option>
        </select>
        <span className="block text-[11px] font-normal">
          Used by + when this bot owns a project. Personal chats stay personal.
        </span>
      </label>
      <label className="block space-y-1 text-xs font-medium text-muted-foreground">
        Starter prompt
        <textarea
          aria-label="Starter prompt"
          className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground"
          value={value.initialPrompt}
          maxLength={8192}
          onChange={(event) => onChange({ ...value, initialPrompt: event.target.value })}
          placeholder="An optional starting point for new conversations…"
        />
        <span className="block text-[11px] font-normal">
          Prefills an empty draft. You can change everything before sending.
        </span>
      </label>
    </fieldset>
  );
}
