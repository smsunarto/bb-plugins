import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_PermissionModePicker as PermissionModePicker,
} from "@get-bb/plugin-sdk/app";
import { useId, type Dispatch, type SetStateAction } from "react";
import type { LaunchPreset } from "../lib/launch-preset";
import { Label } from "./ui/label";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Field, SwitchRow } from "./editor-fields";

const WORKSPACES = [
  {
    value: "checkout",
    title: "Project checkout",
    detail: "Work in the project's main folder.",
  },
  {
    value: "worktree",
    title: "Fresh worktree",
    detail: "Start each conversation on its own branch.",
  },
] as const satisfies readonly { value: LaunchPreset["workspace"]; title: string; detail: string }[];

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
  const id = useId();
  const execution = value.execution;
  const routing = hostId ? { kind: "host" as const, hostId } : undefined;
  return (
    <fieldset disabled={disabled} className="space-y-4">
      <div className="space-y-2">
        <SwitchRow
          id={`${id}-model`}
          label="Preferred model"
          detail={
            execution ? "New conversations start on this model." : "Uses the project's default."
          }
          checked={execution !== null}
          onCheckedChange={(checked) =>
            onChange({
              ...value,
              execution: checked
                ? { providerId: "", model: "", reasoningLevel: "medium", permissionMode: null }
                : null,
            })
          }
        >
          {execution ? (
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
          ) : null}
        </SwitchRow>
        {execution ? (
          <SwitchRow
            id={`${id}-permissions`}
            label="Custom permissions"
            detail={
              execution.providerId ? "Override the project's approval mode." : "Pick a model first."
            }
            checked={execution.permissionMode !== null}
            disabled={disabled || !execution.providerId}
            onCheckedChange={(checked) =>
              onChange({
                ...value,
                execution: { ...execution, permissionMode: checked ? "accept-edits" : null },
              })
            }
          >
            {execution.permissionMode !== null ? (
              <PermissionModePicker
                providerId={execution.providerId}
                value={execution.permissionMode}
                routing={routing}
                disabled={disabled || !hostId}
                align="start"
                className="h-8"
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
          </SwitchRow>
        ) : null}
      </div>
      <Field
        label="Workspace"
        detail="Applies to + on a project this bot owns. Home chats are unaffected."
      >
        <RadioGroup
          aria-label="Project workspace"
          className="grid-cols-2"
          value={value.workspace}
          onValueChange={(workspace) =>
            onChange({ ...value, workspace: workspace as LaunchPreset["workspace"] })
          }
        >
          {WORKSPACES.map((option) => (
            <Label
              key={option.value}
              htmlFor={`${id}-${option.value}`}
              className="cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 font-normal transition-colors duration-150 hover:bg-state-hover hover:duration-0 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-state-active"
            >
              <RadioGroupItem id={`${id}-${option.value}`} value={option.value} />
              <span className="min-w-0 space-y-1">
                <span className="block font-medium">{option.title}</span>
                <span className="block leading-4 text-muted-foreground">{option.detail}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </Field>
    </fieldset>
  );
}
