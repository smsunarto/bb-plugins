import { useCallback, useRef, useState } from "react";
import {
  experimental_PermissionModePicker as PermissionModePicker,
  useComposer,
  type ComposerSelection,
} from "@get-bb/plugin-sdk/app";
import { isAnchorInteractive } from "@/components/ui/overlay-anchor";
import { useCatalogRouting, type CatalogRouting } from "./model-picker/catalog";
import { hasEditablePickers } from "./model-picker/ComposerModelControls";

type PermissionMode = NonNullable<ComposerSelection["permissionMode"]>;

type PickerRouting =
  | { kind: "environment"; environmentId: string }
  | { kind: "host"; hostId: string };

function pickerRouting(routing: CatalogRouting): PickerRouting | undefined {
  if (routing.kind === "environment") {
    return { kind: "environment", environmentId: routing.environmentId };
  }
  if (routing.kind === "host") return { kind: "host", hostId: routing.hostId };
  return undefined;
}

/**
 * BB's permission picker inside the card, where ChatGPT shows "Approve for me".
 * Picks go through `setSelection`, the same path as BB's own picker. Once this
 * picker renders, app.css hides BB's copy in the context row, except while BB
 * disables its copy (plan mode, a permission snapshot, a pending question):
 * then BB's copy shows the effective mode and this one is hidden.
 */
export function ComposerPermissionControl() {
  const composer = useComposer();
  const editable = hasEditablePickers(composer);
  const routing = useCatalogRouting(composer, editable);
  const [error, setError] = useState<string | null>(null);
  const controlRef = useRef<HTMLSpanElement>(null);
  const latestPick = useRef(0);
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const refused = useRef<PermissionMode | null>(null);
  // Stable, because BB's picker re-runs its clamp effect whenever `onChange` changes.
  const apply = useCallback((permissionMode: PermissionMode) => {
    // BB refuses changes on some threads, such as a permission snapshot; never retry one.
    if (permissionMode === refused.current) return;
    const pick = ++latestPick.current;
    if (controlRef.current && !isAnchorInteractive(controlRef.current)) {
      setError("Answer the agent's question first.");
      return;
    }
    setError(null);
    composerRef.current
      .setSelection({ permissionMode })
      .then((applied) => {
        if (applied.permissionMode !== permissionMode) {
          refused.current = permissionMode;
          if (pick === latestPick.current) setError("BB kept the current permission mode.");
        }
        return applied;
      })
      .catch((reason: unknown) => {
        if (pick === latestPick.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
  }, []);
  const selection = composer.selection;
  if (!editable || !routing || !selection?.providerId || !selection.permissionMode) return null;

  return (
    <span ref={controlRef} data-t3-permission="" className="flex min-w-0 items-center">
      <PermissionModePicker
        providerId={selection.providerId}
        value={selection.permissionMode}
        onChange={apply}
        routing={pickerRouting(routing)}
        align="start"
      />
      {error ? (
        <span
          role="alert"
          className="ml-1 max-w-48 truncate text-xs text-destructive"
          title={error}
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}
