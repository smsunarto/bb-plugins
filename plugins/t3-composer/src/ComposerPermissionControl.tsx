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
import {
  notePermissionRefused,
  usePermissionInfo,
  useCatalogRouting,
  type PermissionInfo,
} from "./model-picker/catalog";
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
// workaround:t3-composer/thread-permission-reset begin
import { useKeptPermissionMode } from "./thread-permission-picks";
// workaround:t3-composer/thread-permission-reset end

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
  const sdk = useSdk();
  const onRefused = (requested: PermissionMode, applied: PermissionMode | null) => {
    if (routing && providerId) notePermissionRefused(sdk, routing, providerId, requested, applied);
  };
  const { error, pick } = usePermissionMode(
    composer,
    editable ? info : undefined,
    controlRef,
    onRefused,
  );
  // workaround:t3-composer/thread-permission-reset begin
  useKeptPermissionMode(composer, editable, info);
  // workaround:t3-composer/thread-permission-reset end

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

/** A mode BB applied something else for, in the composer and at the mode it was asked from. */
interface Refusal {
  key: string;
  mode: PermissionMode;
  seen: PermissionMode | null;
}

/** Why the last pick did not apply, for the mode it was raised against in its composer. */
interface PickError {
  key: string;
  mode: PermissionMode | null;
  text: string;
}

/**
 * The composer's pick, and why the last one did not apply. A mode the machine's limit does not
 * allow settles as BB's picker settles it, and a mode BB refused, such as on a permission
 * snapshot, is not retried until the mode changes. `onRefused` hears each pick BB did not apply,
 * for the machine the pick was made on.
 */
function usePermissionMode(
  composer: PluginComposerApi,
  info: PermissionInfo | undefined,
  controlRef: RefObject<HTMLElement | null>,
  onRefused: (requested: PermissionMode, applied: PermissionMode | null) => void,
): { error: PickError | null; pick(mode: PermissionMode): void } {
  const { key } = composer;
  const value = composer.selection?.permissionMode ?? null;
  const [error, setError] = useState<PickError | null>(null);
  // A message speaks for the mode it was raised against, in the composer it was raised in.
  if (error && (error.key !== key || error.mode !== value)) setError(null);
  const latestPick = useRef(0);
  const refused = useRef<Refusal | null>(null);
  const composerRef = useRef(composer);
  const onRefusedRef = useRef(onRefused);
  // `apply` runs from the picker's selection or the effect below, both after this sync.
  useLayoutEffect(() => {
    composerRef.current = composer;
    onRefusedRef.current = onRefused;
  });

  // Stable, so the effect below does not re-run for a new callback.
  const apply = useCallback(
    (permissionMode: PermissionMode) => {
      const target = composerRef.current;
      const pickKey = target.key;
      const current = target.selection?.permissionMode ?? null;
      const pick = ++latestPick.current;
      const refusedOn = onRefusedRef.current;
      setError(null);
      if (controlRef.current && !isAnchorInteractive(controlRef.current)) {
        setError({ key: pickKey, mode: current, text: "Answer the agent's question first." });
        return;
      }
      void applySelection(target, { permissionMode }).then(({ applied, error }) => {
        const appliedMode = applied?.permissionMode ?? null;
        if (applied && appliedMode !== permissionMode) {
          refused.current = { key: pickKey, mode: permissionMode, seen: appliedMode };
        }
        if (appliedMode !== permissionMode) refusedOn(permissionMode, appliedMode);
        if (error && pick === latestPick.current) {
          setError({ key: pickKey, mode: applied ? appliedMode : current, text: error });
        }
        return applied;
      });
    },
    [controlRef],
  );

  const provider = info?.provider ?? null;
  // Once the machine answers, a value it does not allow settles as BB's picker settles it.
  const settled =
    info && provider && value ? resolvePermissionMode(value, provider.modes, info.ceiling) : null;
  useEffect(() => {
    if (!settled || settled === value) return;
    // A refusal holds only for the composer and mode it came from.
    const last = refused.current;
    if (last?.key === key && last.mode === settled && last.seen === value) return;
    apply(settled);
  }, [apply, key, settled, value]);

  return { error, pick: apply };
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
      <span className="contents" title={current ? `Permission mode: ${label}` : undefined}>
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
 * One mode: icon and name, with a check on the current one; a mode above the machine's limit
 * also says why it is unavailable. Rows are split by hairlines inset to the text, and the
 * elevated mode keeps BB's warning tone.
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
          {/* A mode above the machine's limit says why it cannot be picked. */}
          {option.disabled ? (
            <span
              className={cn(
                "text-pretty text-muted-foreground",
                large ? "text-sm leading-5" : "text-xs leading-4",
              )}
            >
              {CEILING_REASON}
            </span>
          ) : null}
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
