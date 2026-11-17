import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useSdk, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon } from "@/components/ui/icon";
import { isAnchorInteractive } from "@/components/ui/overlay-anchor";
import { cn } from "@/lib/utils";
import { applySelection } from "./composer-settings/apply-selection";
import { usePermissionInfo, useCatalogRouting, type PermissionInfo } from "./model-picker/catalog";
import { markComposerHost } from "./composer-host";
import { usePickerComposer } from "./composer-handle";
import { hasEditablePickers } from "./model-picker/ComposerModelControls";
import {
  CEILING_REASON,
  permissionModeOption,
  permissionModeOptions,
  resolvePermissionMode,
  type PermissionMode,
  type PermissionModeOption,
} from "./permission-modes";
import {
  forgetPermissionMode,
  keepPermissionMode,
  keptPermissionMode,
} from "./thread-permission-picks";

/**
 * The permission picker inside the card, where ChatGPT shows "Approve for me": a grouped
 * list of BB's modes under a question naming the provider, a sheet on phones. It reads the
 * machine's ceiling and the provider's modes from the same response as BB's own picker and
 * settles an unsupported value the way BB's does. Picks go through `setSelection`, the
 * same path as BB's picker. Once this picker renders, app.css hides BB's copy in the context
 * row, except while BB disables its copy (plan mode, a permission snapshot, a pending
 * question): then BB's copy shows the effective mode and this one is hidden.
 */
export const ComposerPermissionControl = memo(function ComposerPermissionControl() {
  const composer = usePickerComposer();
  const editable = hasEditablePickers(composer);
  const routing = useCatalogRouting(composer, editable);
  const providerId = composer.selection?.providerId ?? null;
  const value = composer.selection?.permissionMode ?? null;
  const info = usePermissionInfo(editable ? routing : null, providerId);
  const provider = info?.provider ?? null;
  const options = info && provider ? permissionModeOptions(provider.modes, info.ceiling) : null;
  const controlRef = useRef<HTMLSpanElement>(null);
  const { error, pick } = usePermissionMode(composer, editable, info, controlRef);

  const shown = Boolean(
    editable && routing && providerId && value && (!info || (provider && options?.length)),
  );
  // While this picker shows, the stylesheet hides BB's copy in the tray (see app.css).
  useLayoutEffect(
    () => (shown ? markComposerHost(controlRef.current, "data-t3-permission-host") : undefined),
    [shown],
  );
  if (!shown || !value) return null;

  return (
    <span ref={controlRef} data-t3-permission="" className="flex min-w-0 items-center">
      <PermissionPicker
        value={value}
        providerName={provider?.name ?? null}
        // Read-only until the machine answers, like BB's picker.
        options={options}
        onChange={pick}
      />
      {error ? (
        <span
          role="alert"
          className="ml-1 max-w-48 truncate text-xs text-destructive"
          title={error.text}
        >
          {error.text}
        </span>
      ) : null}
    </span>
  );
});

/** Why the last pick did not apply, for the mode it was raised against in its composer. */
interface PickError {
  key: string;
  mode: PermissionMode | null;
  text: string;
}

/**
 * Where a composer stands on its thread's kept pick: waiting for the machine's limit,
 * restoring it through BB, or done, when later changes replace the kept pick.
 */
interface ThreadSync {
  key: string;
  phase: "waiting" | "restoring" | "done";
  /** The mode last seen once done, so a change made since can be told apart from it. */
  seen: PermissionMode | null;
}

/**
 * The composer's permission mode, kept per thread and settled under the machine's limit.
 *
 * BB resets a thread composer's mode to the thread's last sent one whenever the thread opens
 * again, so a pick made here is kept per thread and put back, settled under the machine's
 * limit, once that limit is known. Later changes from any picker or shortcut replace the kept
 * pick. A mode the limit does not allow settles as BB's picker settles it, and a mode BB
 * refused, such as on a permission snapshot, is not retried until the mode changes.
 */
function usePermissionMode(
  composer: PluginComposerApi,
  editable: boolean,
  info: PermissionInfo | undefined,
  controlRef: RefObject<HTMLElement | null>,
): { error: PickError | null; pick(mode: PermissionMode): void } {
  const sdk = useSdk();
  const { key } = composer;
  const value = composer.selection?.permissionMode ?? null;
  // Only a thread's own composer keeps a pick; a new thread starts at BB's default.
  const threadId = editable && composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const [error, setError] = useState<PickError | null>(null);
  // A message speaks for the mode it was raised against, in the composer it was raised in.
  if (error && (error.key !== key || error.mode !== value)) setError(null);
  const latestPick = useRef(0);
  const refused = useRef<{ key: string; mode: PermissionMode } | null>(null);
  const sync = useRef<ThreadSync | null>(null);
  const composerRef = useRef(composer);
  // The callbacks below run from the picker's selection or the effect, both after this sync.
  useLayoutEffect(() => {
    composerRef.current = composer;
  });

  // Stable, so the effect below does not re-run for a new callback.
  const apply = useCallback(
    (permissionMode: PermissionMode, source: "pick" | "settle") => {
      const target = composerRef.current;
      const pickKey = target.key;
      const pickThreadId = target.scope.kind === "thread" ? target.scope.threadId : null;
      const current = target.selection?.permissionMode ?? null;
      const pick = ++latestPick.current;
      if (source === "pick" && sync.current?.key === pickKey) sync.current.phase = "done";
      setError(null);
      if (controlRef.current && !isAnchorInteractive(controlRef.current)) {
        setError({ key: pickKey, mode: current, text: "Answer the agent's question first." });
        return;
      }
      // Kept before BB answers, so a thread switch right after the pick keeps it too.
      const previous = pickThreadId === null ? undefined : keptPermissionMode(pickThreadId);
      const keeps = source === "pick" && pickThreadId !== null;
      if (keeps) keepPermissionMode(sdk, pickThreadId, permissionMode);
      void applySelection(target, { permissionMode }).then(({ applied, error }) => {
        const appliedMode = applied?.permissionMode ?? null;
        if (applied && appliedMode !== permissionMode) {
          refused.current = { key: pickKey, mode: permissionMode };
        }
        const undo =
          keeps &&
          appliedMode !== permissionMode &&
          keptPermissionMode(pickThreadId) === permissionMode;
        if (undo && previous) keepPermissionMode(sdk, pickThreadId, previous);
        else if (undo) forgetPermissionMode(pickThreadId);
        if (error && pick === latestPick.current) {
          setError({ key: pickKey, mode: applied ? appliedMode : current, text: error });
        }
        return applied;
      });
    },
    [controlRef, sdk],
  );
  // Puts a thread's kept pick back without a message: the user did not ask for anything.
  const restore = useCallback((permissionMode: PermissionMode) => {
    const target = composerRef.current;
    const restoreKey = target.key;
    sync.current = { key: restoreKey, phase: "restoring", seen: null };
    void applySelection(target, { permissionMode }).then(({ applied }) => {
      const appliedMode = applied?.permissionMode ?? null;
      if (applied && appliedMode !== permissionMode) {
        refused.current = { key: restoreKey, mode: permissionMode };
      }
      if (sync.current?.key === restoreKey && sync.current.phase === "restoring") {
        // What BB applied, so a change made before the next render still counts as one.
        sync.current = { key: restoreKey, phase: "done", seen: appliedMode };
      }
      return applied;
    });
  }, []);

  const provider = info?.provider ?? null;
  const settled =
    info && provider && value ? resolvePermissionMode(value, provider.modes, info.ceiling) : null;
  const kept = threadId === null ? undefined : keptPermissionMode(threadId);
  const restoreTo =
    kept && info && provider ? resolvePermissionMode(kept, provider.modes, info.ceiling) : null;
  useEffect(() => {
    if (!value) return;
    if (sync.current?.key !== key) {
      sync.current = { key, phase: kept ? "waiting" : "done", seen: null };
      refused.current = null;
    }
    const { phase, seen } = sync.current;
    const changed = seen !== null && seen !== value;
    if (changed) refused.current = null;
    if (phase === "waiting") {
      // Restored even when BB shows the pick already, so a late thread default cannot replace it.
      if (restoreTo !== null) restore(restoreTo);
      return;
    }
    if (phase === "restoring") return;
    if (threadId !== null && kept && changed) keepPermissionMode(sdk, threadId, value);
    sync.current = { key, phase, seen: value };
    const blocked = refused.current?.key === key && refused.current.mode === settled;
    if (settled && settled !== value && !blocked) apply(settled, "settle");
  }, [apply, key, kept, restore, restoreTo, sdk, settled, threadId, value]);

  const pick = useCallback((mode: PermissionMode) => apply(mode, "pick"), [apply]);
  return { error, pick };
}

const WARNING_TEXT = "text-warning-text";

export function PermissionPicker(props: {
  value: PermissionMode;
  providerName: string | null;
  options: readonly PermissionModeOption[] | null;
  onChange(value: PermissionMode): void;
}) {
  const { value, options } = props;
  const isSheet = useIsCompactViewport();
  const titleId = useId();
  const current = permissionModeOption(value);
  const label = current?.label ?? value;
  const warning = current?.tone === "warning";
  const interactive = options !== null && options.length > 1;
  const title = props.providerName
    ? `How should ${props.providerName} actions be approved?`
    : "How should actions be approved?";

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label="Permission mode"
      disabled={!interactive}
      className={cn(
        "h-8 w-fit min-w-0 max-w-full items-center justify-start gap-1 border-none bg-transparent px-1 text-xs leading-tight shadow-none",
        warning
          ? `${WARNING_TEXT} hover:text-warning-text data-[state=open]:text-warning-text`
          : "text-muted-foreground hover:text-muted-foreground",
        !interactive && "cursor-default disabled:opacity-100",
      )}
    >
      <span
        className="contents"
        title={current ? `Permission mode: ${label} - ${current.description}` : undefined}
      >
        <span className="min-w-0 truncate" data-promptbox-full-label="">
          {label}
        </span>
        {current ? (
          <span className="min-w-0 truncate" data-promptbox-compact-label="">
            {current.compactLabel}
          </span>
        ) : null}
      </span>
    </Button>
  );
  if (!interactive) return trigger;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        data-t3-composer-menu=""
        data-t3-permission-menu=""
        align="start"
        mobileTitle={title}
        aria-labelledby={titleId}
        className={isSheet ? "gap-4 px-4 pb-4 pt-1" : "w-80"}
      >
        {/* The sheet's dialog already reads the title, from its own hidden heading. */}
        <p
          id={titleId}
          aria-hidden={isSheet || undefined}
          className={cn(
            "text-balance text-center font-medium text-foreground",
            isSheet ? "px-4 text-base" : "px-3 pb-2 pt-1 text-xs",
          )}
        >
          {title}
        </p>
        <div
          className={cn(
            "flex flex-col overflow-hidden bg-foreground/[0.04]",
            isSheet ? "rounded-2xl" : "rounded-lg",
          )}
        >
          {options.map((option) => (
            <PermissionRow
              key={option.value}
              option={option}
              selected={option.value === value}
              large={isSheet}
              onSelect={props.onChange}
            />
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One mode: icon, name and what it allows, with a check on the current one. Rows are split
 * by hairlines inset to the text, and the elevated mode keeps BB's warning tone, across the
 * whole row once chosen.
 */
function PermissionRow(props: {
  option: PermissionModeOption;
  selected: boolean;
  large: boolean;
  onSelect(value: PermissionMode): void;
}) {
  const { option, selected, large } = props;
  const warning = option.tone === "warning";
  const iconSize = large ? "size-5" : "size-3.5";
  return (
    <DropdownMenuItem
      role="menuitemradio"
      aria-checked={selected}
      disabled={option.disabled}
      onSelect={() => props.onSelect(option.value)}
      className={cn(
        "group/row items-stretch gap-0 whitespace-normal rounded-none py-0 pr-0 text-foreground max-md:pointer-coarse:py-0",
        large ? "pl-4" : "pl-3",
      )}
    >
      {/* Wrapped, so the menu item's own icon size does not apply. */}
      <span aria-hidden className={cn("flex shrink-0 items-center", warning && WARNING_TEXT)}>
        <Icon name={option.icon} className={iconSize} />
      </span>
      <span
        className={cn(
          "flex min-w-0 flex-1 items-center border-t border-border-hairline group-first/row:border-t-0",
          large ? "ml-4 gap-4 py-3 pr-4" : "ml-3 gap-3 py-2 pr-3",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              large ? "text-base leading-6" : "text-xs font-medium leading-4",
              warning && WARNING_TEXT,
            )}
          >
            {option.label}
          </span>
          <span
            className={cn(
              "text-pretty",
              large ? "text-sm leading-5" : "text-xs leading-4",
              warning && selected ? WARNING_TEXT : "text-muted-foreground",
            )}
          >
            {option.disabled ? CEILING_REASON : option.description}
          </span>
        </span>
        <Icon
          name="Check"
          aria-hidden
          className={cn(iconSize, "shrink-0", selected ? "opacity-100" : "opacity-0")}
        />
      </span>
    </DropdownMenuItem>
  );
}
