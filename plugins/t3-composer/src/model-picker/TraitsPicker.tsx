// Adapted from T3 Code's TraitsPicker.tsx: the effort word that reads on from the
// model name, opening Codex's effort panel. The panel's header holds the speed bolt and
// Daybreak at the left and, on desktop, a reset button at the right; the phone sheet has
// a larger slider. Daybreak has no SDK setter, so the panel drives BB's own picker for it.
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { AgentSwitchToggle } from "./AgentSwitchToggle";
import {
  BbSwitchMissing,
  DRIVING_ATTRIBUTE,
  readBbSwitch,
  toggleBbSwitch,
} from "./bb-picker-driver";
import { EffortSlider } from "./EffortSlider";
import { DaybreakGlyph, FastBolt } from "./glyphs";
import { SpeedToggle, speedCycle } from "./SpeedToggle";
import type { Traits } from "./traits";

/** Keys that adjust the slider; Up and Down move between it and the header buttons. */
const SLIDER_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);
const HEADER_ITEMS = '[role="menuitem"]:not([data-disabled])';

/**
 * A switch's value, or "missing" where BB's picker does not offer it, as of `at`. `verified`
 * marks a value read back from BB rather than one a press has only just set.
 */
type KnownSwitch = { on: boolean | "missing"; verified: boolean; at: number };
/** Each composer and model's last known switch, so a reopened panel shows it at once. */
const knownSwitches = new Map<string, KnownSwitch>();
/** How long after a press to read the value again, past a failed thread update's rollback. */
const RECHECK_AFTER_MS = 2500;
/** A read older than this is read again when the panel opens, since BB can change the value
 * elsewhere, roll back a slow failed update, or offer a switch it hid while busy. */
const KNOWN_FOR_MS = 120_000;
/** After a click on the panel cuts a read short, wait this long before reading again, once. */
const RETRY_AFTER_MS = 1000;

function isFresh(known: KnownSwitch | undefined): known is KnownSwitch {
  return known !== undefined && known.verified && Date.now() - known.at < KNOWN_FOR_MS;
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function TraitsPicker(props: {
  effort: Traits["effort"];
  speed: Traits["speed"];
  daybreak: Traits["daybreak"];
  /** BB's own picker, mounted out of sight while the panel is open, to reach Daybreak. */
  bbPicker: ReactNode;
  /** Names this composer and model, for `knownSwitches`. */
  switchKey: string;
  disabled?: boolean;
  onEffortChange(level: string): void | Promise<unknown>;
  onSpeedChange(tier: string): void;
  /** Reports a failed read or press; null clears it once one succeeds. */
  onError(message: string | null): void;
}) {
  const { effort, speed, daybreak } = props;
  // The same breakpoint at which DropdownMenuContent renders as a bottom sheet.
  const isSheet = useIsCompactViewport();
  const contentRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // The panel's contents, once rendered; a phone's sheet renders them a frame or two late.
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const {
    missing: daybreakMissing,
    on: daybreakValue,
    pending: daybreakPending,
    mounted: bbPickerMounted,
    attachHost,
    toggle: toggleDaybreak,
  } = useAgentSwitch(
    daybreak && props.bbPicker ? daybreak.label : null,
    open && panel !== null,
    props,
  );
  const agentSwitch = daybreak && !daybreakMissing ? daybreak : null;
  // A missing switch keeps the pill, so a later open can find it again.
  if (!effort && !speed && !daybreak) return null;

  const effortWord =
    effort?.options.find((option) => option.id === effort.current)?.label ?? effort?.current;
  const activeSpeed = speed ? speedCycle(speed).active : null;
  const daybreakOn = agentSwitch !== null && daybreakValue === true;
  // Without effort levels the pill names what the panel holds instead.
  const fallbackWord = speed ? "Speed" : (daybreak?.label ?? "");
  const triggerName = [
    effortWord ? `Effort: ${effortWord}` : fallbackWord,
    activeSpeed?.label,
    daybreakOn ? agentSwitch?.label : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const slider = () => contentRef.current?.querySelector<HTMLElement>('[role="slider"]');
  const headerItems = () => [
    ...(contentRef.current?.querySelectorAll<HTMLElement>(HEADER_ITEMS) ?? []),
  ];
  const defaultEffort = effort?.options.find((option) => option.isDefault);

  const leading =
    speed || agentSwitch ? (
      <>
        {speed ? (
          <SpeedToggle speed={speed} large={isSheet} onChange={props.onSpeedChange} />
        ) : null}
        {agentSwitch ? (
          <AgentSwitchToggle
            option={agentSwitch}
            on={daybreakValue}
            pending={daybreakPending}
            large={isSheet}
            onToggle={toggleDaybreak}
          />
        ) : null}
      </>
    ) : null;

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={props.disabled}
          aria-label={triggerName}
          title={triggerName}
          data-t3-traits-trigger=""
          data-t3-traits-word={effortWord ? "" : undefined}
          className="shrink-0 gap-1 whitespace-nowrap"
        >
          {activeSpeed ? (
            <span data-t3-traits-speed="" className="flex shrink-0">
              <FastBolt ultra={activeSpeed.ultra} />
            </span>
          ) : null}
          {daybreakOn ? (
            <span data-t3-traits-agent-switch="" className="flex shrink-0">
              <DaybreakGlyph className="size-3" />
            </span>
          ) : null}
          {effortWord ?? (activeSpeed || daybreakOn ? null : fallbackWord)}
        </button>
      </DropdownMenuTrigger>
      {/* Out of sight and inert between drives; see bb-picker-driver.ts. */}
      {bbPickerMounted ? (
        <span ref={attachHost} data-t3-bb-picker-host="" aria-hidden inert>
          {props.bbPicker}
        </span>
      ) : null}
      <DropdownMenuContent
        ref={(node) => {
          contentRef.current = node;
          setPanel(node);
        }}
        data-t3-composer-menu=""
        align="start"
        mobileTitle="Effort"
        className={isSheet ? undefined : "max-w-none"}
        // BB's picker takes focus while the panel drives it; the panel stays open.
        onFocusOutside={(event) => {
          if (document.documentElement.hasAttribute(DRIVING_ATTRIBUTE)) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (document.documentElement.hasAttribute(DRIVING_ATTRIBUTE)) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (isSheet) return;
          const target = panelKeyTarget(event, headerItems(), slider());
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        {effort ? (
          <EffortSlider
            options={effort.options}
            current={effort.current}
            large={isSheet}
            focusFromKeyboard={!isSheet}
            onChange={props.onEffortChange}
            leading={leading}
            trailing={
              !isSheet && defaultEffort ? (
                <ResetButton
                  label={`Reset effort to ${defaultEffort.label}`}
                  // Hidden and disabled at the default rather than unmounted, so a hovered or
                  // focused reset never vanishes from under the pointer or the keyboard.
                  hidden={effort.current === defaultEffort.id}
                  onSelect={() => {
                    // Keep focus in the panel once the default applies and the button hides.
                    slider()?.focus();
                    void props.onEffortChange(defaultEffort.id);
                  }}
                />
              ) : null
            }
            {...(isSheet
              ? {}
              : {
                  onArrowUpDown: (key: "ArrowUp" | "ArrowDown") => {
                    const items = headerItems();
                    (key === "ArrowUp" ? items.at(-1) : items[0])?.focus();
                  },
                })}
          />
        ) : (
          <div className="flex items-center gap-0.5">{leading}</div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Daybreak's value, read from BB's picker the first time the panel opens for this composer and
 * model, and flipped through it. `label` is null when the model has no such switch.
 */
function useAgentSwitch(
  label: string | null,
  open: boolean,
  props: { switchKey: string; onError(message: string | null): void },
) {
  const key = `${props.switchKey}|${label ?? ""}`;
  const [known, setKnown] = useState<KnownSwitch | undefined>(() => knownSwitches.get(key));
  const [pending, setPending] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  // A drive in flight keeps BB's picker mounted until it has closed it.
  const [driving, setDriving] = useState(0);
  // Bumped after a press, to read again once BB may have rolled a failed update back.
  const [recheck, setRecheck] = useState(0);
  const currentKey = useRef(key);
  const press = useRef<AbortController | null>(null);
  // One retry per opening, so Escape, which closes BB's picker first, does not reopen it.
  const retried = useRef(false);
  const reportError = useEffectEvent((error: unknown) => {
    if (!isAbort(error)) props.onError(error instanceof Error ? error.message : String(error));
  });
  const clearError = useEffectEvent(() => props.onError(null));
  const later = useEffectEvent((ms: number) =>
    window.setTimeout(() => setRecheck((count) => count + 1), ms),
  );

  /** Records a result for the composer and model it was read for; a stale one stays cached. */
  const settle = (forKey: string, on: boolean | "missing", verified: boolean) => {
    const value = { on, verified, at: Date.now() };
    knownSwitches.set(forKey, value);
    if (currentKey.current === forKey) setKnown(value);
  };

  // A press belongs to one composer and model; changing either, or unmounting, abandons it.
  useEffect(() => {
    currentKey.current = key;
    setKnown(knownSwitches.get(key));
    return () => press.current?.abort(new DOMException("The model changed.", "AbortError"));
  }, [key]);

  // Read when the panel opens on a value that is not fresh; closing the panel stops the read.
  useEffect(() => {
    if (!open || !label || !host || isFresh(knownSwitches.get(key))) return;
    const controller = new AbortController();
    let retry: number | undefined;
    setDriving((count) => count + 1);
    readBbSwitch(host, label, controller.signal)
      .then((on) => {
        settle(key, on, true);
        clearError();
        return on;
      })
      .catch((error: unknown) => {
        if (error instanceof BbSwitchMissing) settle(key, "missing", true);
        // A click on the panel closed BB's picker mid-read; try again once the user pauses.
        else if (isAbort(error) && !controller.signal.aborted && !retried.current) {
          retried.current = true;
          retry = later(RETRY_AFTER_MS);
        } else reportError(error);
      })
      .finally(() => setDriving((count) => count - 1));
    return () => {
      window.clearTimeout(retry);
      controller.abort(new DOMException("The panel closed.", "AbortError"));
    };
    // oxlint-disable-next-line react/exhaustive-deps -- `settle` reads `key`, already a dependency.
  }, [open, label, host, key, recheck]);

  // A press still in flight when the panel closes is abandoned; its result is then unknown.
  useEffect(() => {
    retried.current = false;
    if (open) return;
    press.current?.abort(new DOMException("The panel closed.", "AbortError"));
  }, [open]);

  const toggle = () => {
    if (!label || !host || pending) return;
    const forKey = key;
    const controller = new AbortController();
    press.current = controller;
    setPending(true);
    setDriving((count) => count + 1);
    toggleBbSwitch(host, label, controller.signal)
      .then((on) => {
        // A thread applies the change optimistically and rolls it back if the update fails,
        // so the value stays unconfirmed until a later read sees it hold.
        settle(forKey, on, false);
        props.onError(null);
        later(RECHECK_AFTER_MS);
        return on;
      })
      .catch((error: unknown) => {
        const cached = knownSwitches.get(forKey);
        if (error instanceof BbSwitchMissing) settle(forKey, "missing", true);
        else {
          // The press may or may not have landed; read again on the next look.
          if (cached) settle(forKey, cached.on, false);
          if (!isAbort(error)) {
            props.onError(error instanceof Error ? error.message : String(error));
          }
        }
      })
      .finally(() => {
        if (press.current === controller) press.current = null;
        setPending(false);
        setDriving((count) => count - 1);
      });
  };

  const missing = known?.on === "missing";
  return {
    /** Hidden where BB's picker does not offer the switch, until it is read again. */
    missing,
    on: label && typeof known?.on === "boolean" ? known.on : null,
    pending,
    mounted: (open && label !== null) || driving > 0,
    attachHost: setHost,
    toggle,
  };
}

/**
 * Where an arrow key in the desktop panel moves focus. After a pointer open the menu itself has
 * focus: Left, Right, Home and End go to the slider, and Up and Down reach the header buttons
 * through Radix. In the header, Left and Right step along it, and Up from its first button or
 * Down from its last returns to the slider.
 */
function panelKeyTarget(
  event: KeyboardEvent<HTMLDivElement>,
  items: HTMLElement[],
  slider: HTMLElement | null | undefined,
) {
  if (event.target === event.currentTarget) {
    return SLIDER_KEYS.has(event.key) || (items.length === 0 && event.key.startsWith("Arrow"))
      ? slider
      : null;
  }
  const at = items.indexOf(event.target as HTMLElement);
  if (at === -1) return null;
  if (event.key === "ArrowRight") return items[at + 1] ?? null;
  if (event.key === "ArrowLeft") return items[at - 1] ?? null;
  if (event.key === "ArrowDown" && at === items.length - 1) return slider;
  if (event.key === "ArrowUp" && at === 0) return slider;
  return null;
}

/** The panel's reset button; a menu item so the menu's arrow keys reach it. */
function ResetButton(props: { label: string; hidden: boolean; onSelect(): void }) {
  return (
    <DropdownMenuItem
      aria-label={props.label}
      title={props.label}
      // Typeahead matches this text; the icon gives the item none of its own.
      textValue={props.label}
      disabled={props.hidden}
      aria-hidden={props.hidden || undefined}
      // The panel stays open, as Codex's does.
      onSelect={(event) => {
        event.preventDefault();
        props.onSelect();
      }}
      className={cn(
        "size-8 justify-center rounded-md p-0 text-muted-foreground data-[highlighted]:text-foreground",
        props.hidden && "invisible",
      )}
    >
      <Icon name="RotateCcw" className="size-4" aria-hidden />
    </DropdownMenuItem>
  );
}
