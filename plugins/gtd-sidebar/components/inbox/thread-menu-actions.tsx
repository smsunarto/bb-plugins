import { Fragment, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  experimental_Icon as RegistryIcon,
  experimental_useThreadActions as useThreadActions,
  useSettings,
  type PluginSidebarThread,
  type PluginThreadActionChoices,
  type PluginThreadActionEntry,
} from "@get-bb/plugin-sdk/app";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";
import { attachHapticTrigger } from "../../lib/ios-haptics";
import { ARCHIVE_ACTION_KEY, toThreadActionTarget } from "../../lib/thread-action-target";
import type { ThreadActionPlan } from "./thread-actions";
import { MENU_ITEM_CLASS, MenuSeparator, MenuSubSurface } from "./menu-surface";

/** One menu row, from the GTD plan or from bb's thread action registry. */
interface MenuRow {
  key: string;
  label: string;
  /** A muted second line, such as a choice list's current value. */
  detail?: string;
  icon: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  choices?: PluginThreadActionChoices;
  run(value?: string): void;
}

/**
 * One action order for the desktop menu and the touch sheet: the GTD
 * lifecycle moves, then every action in bb's thread action registry — bb's
 * own split, copy link, pin, read, rename and delete, and other plugins'
 * (per-thread notifications, say) — grouped the way bb's own thread menu
 * groups them. bb's Archive is left out: Settle and Un-settle stand in for it.
 *
 * Called only by a menu that is open, so the list holds one registry
 * subscription at most and a row holds none.
 */
function useThreadMenuGroups(
  thread: PluginSidebarThread,
  plan: ThreadActionPlan,
  requestRename: () => void,
): MenuRow[][] {
  const entries = useThreadActions(toThreadActionTarget(thread), { requestRename });
  return menuGroups(plan, entries);
}

/**
 * The GTD moves as the first group, then the registry's entries in its menu
 * order, a new group wherever the registry's group changes.
 */
function menuGroups(
  plan: ThreadActionPlan,
  entries: readonly PluginThreadActionEntry[],
): MenuRow[][] {
  const groups: MenuRow[][] = [];
  if (plan.length > 0) {
    groups.push(
      plan.map((action) => ({
        key: `gtd/${action.id}`,
        label: action.label,
        icon: <Icon name={action.icon} className="size-full" />,
        run: action.execute,
      })),
    );
  }
  let lastGroup: string | null = null;
  for (const entry of entries) {
    if (entry.key === ARCHIVE_ACTION_KEY) continue;
    const { action } = entry;
    const row: MenuRow = {
      key: entry.key,
      label: action.label,
      ...(action.detail === undefined ? {} : { detail: action.detail }),
      icon: <RegistryIcon name={action.icon} aria-hidden className="size-full" />,
      destructive: action.variant === "destructive",
      ...(action.disabled === undefined ? {} : { disabled: action.disabled }),
      ...(action.choices === undefined ? {} : { choices: action.choices }),
      // Errors are contained and logged by bb; the menu never breaks.
      run: (value) => void action.run(value),
    };
    if (entry.group !== lastGroup || groups.length === 0) groups.push([row]);
    else groups.at(-1)!.push(row);
    lastGroup = entry.group;
  }
  return groups;
}

/** A choice row's name: its label, then the current value, as bb's menu reads it. */
function choiceRowName(row: MenuRow): string | undefined {
  return row.detail === undefined ? undefined : `${row.label}, ${row.detail}`;
}

/** Only a plain action draws its detail as a second line. */
function hasDetailLine(row: MenuRow): boolean {
  return row.detail !== undefined && row.choices === undefined;
}

/**
 * The label, and under it the action's detail on a muted line. A row with a
 * choice list shows only its label; `choiceRowName` reads the detail out.
 */
function RowLabel({ row }: { row: MenuRow }) {
  if (!hasDetailLine(row)) return <span className="min-w-0 truncate">{row.label}</span>;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate">{row.label}</span>
      <span className="truncate text-2xs text-muted-foreground">{row.detail}</span>
    </span>
  );
}

function ChoiceMarks({ choice }: { choice: PluginThreadActionChoices["items"][number] }) {
  return (
    <>
      <span className="min-w-0 flex-1 truncate">{choice.label}</span>
      {choice.selected ? <Icon name="Check" className="ml-auto size-4 shrink-0" /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Desktop: the right-click menu's items.

const DESKTOP_TONE_CLASS = {
  plain: "data-[highlighted]:text-accent-foreground",
  destructive: "text-destructive-text",
};
const DESKTOP_ICON_CLASS = "flex size-4 shrink-0 items-center justify-center";

export function ThreadContextMenuItems({
  thread,
  plan,
  requestRename,
}: {
  thread: PluginSidebarThread;
  plan: ThreadActionPlan;
  requestRename: () => void;
}) {
  const groups = useThreadMenuGroups(thread, plan, requestRename);
  return groups.map((group, index) => (
    <Fragment key={group[0]!.key}>
      {index > 0 && <MenuSeparator />}
      {group.map((row) => {
        const className = cn(
          MENU_ITEM_CLASS,
          row.destructive ? DESKTOP_TONE_CLASS.destructive : DESKTOP_TONE_CLASS.plain,
        );
        const content = (
          <>
            <span className={DESKTOP_ICON_CLASS}>{row.icon}</span>
            <RowLabel row={row} />
          </>
        );
        if (row.choices === undefined) {
          return (
            <ContextMenu.Item
              key={row.key}
              disabled={row.disabled}
              onSelect={() => row.run()}
              className={className}
            >
              {content}
            </ContextMenu.Item>
          );
        }
        const { choices } = row;
        return (
          <ContextMenu.Sub key={row.key}>
            <ContextMenu.SubTrigger
              aria-label={choiceRowName(row)}
              disabled={row.disabled}
              className={cn(className, "data-[state=open]:bg-accent")}
            >
              {content}
              <Icon name="ChevronRight" className="ml-auto size-3.5 shrink-0 opacity-60" />
            </ContextMenu.SubTrigger>
            <MenuSubSurface aria-label={choices.heading ?? row.label} aria-labelledby={undefined}>
              {choices.items.map((choice) => (
                <ContextMenu.Item
                  key={choice.id}
                  aria-current={choice.selected ? "true" : undefined}
                  disabled={choice.disabled}
                  onSelect={() => row.run(choice.id)}
                  className={cn(MENU_ITEM_CLASS, DESKTOP_TONE_CLASS.plain)}
                >
                  {choice.icon === undefined ? null : (
                    <RegistryIcon name={choice.icon} aria-hidden className="size-4 shrink-0" />
                  )}
                  <ChoiceMarks choice={choice} />
                </ContextMenu.Item>
              ))}
              {choices.hint === undefined ? null : (
                <>
                  <MenuSeparator />
                  <div className="max-w-56 px-2 py-1 text-xs text-muted-foreground">
                    {choices.hint}
                  </div>
                </>
              )}
            </MenuSubSurface>
          </ContextMenu.Sub>
        );
      })}
    </Fragment>
  ));
}

// ---------------------------------------------------------------------------
// Touch: the long-press sheet's items.

const SHEET_ITEM_CLASS =
  "relative flex min-h-[44px] cursor-default select-none items-center gap-3.5 px-4 text-[16px] font-normal leading-none tracking-[-0.01em] outline-none focus-visible:bg-state-hover active:bg-state-active aria-disabled:pointer-events-none aria-disabled:opacity-50";
// A hairline across the sheet, edge to edge like an item's pressed fill.
const SHEET_SEPARATOR_CLASS = "my-1.5 h-0 border-0 border-t-[0.5px] border-solid border-border";
const SHEET_ICON_CLASS = "flex size-[20px] shrink-0 items-center justify-center";

/**
 * The sheet's menu. It shows one choice list at a time in place of the
 * actions, with Back, as bb's own drawer does.
 */
export function ThreadSheetMenu({
  thread,
  plan,
  haptics: hapticsAllowed,
  requestRename,
  onClose,
}: {
  thread: PluginSidebarThread;
  plan: ThreadActionPlan;
  /** False where the items' haptic overlays would get in the way. */
  haptics: boolean;
  requestRename: () => void;
  /** Closes the sheet once an action or a choice has run. */
  onClose: () => void;
}) {
  const groups = useThreadMenuGroups(thread, plan, requestRename);
  const { values } = useSettings();
  const haptics = hapticsAllowed && values?.mobileHaptics === true;
  const [step, setStep] = useState<string | null>(null);
  const stepRow = step === null ? undefined : groups.flat().find((row) => row.key === step);
  // An action closes the sheet behind it; moving between the actions and a
  // choice list does not.
  const runAndClose = (row: MenuRow, value?: string) => () => {
    row.run(value);
    onClose();
  };

  return (
    <div role="menu" aria-label="Thread actions" aria-orientation="vertical" className="py-1">
      {stepRow?.choices !== undefined ? (
        <>
          <SheetItem haptics={haptics} onSelect={() => setStep(null)}>
            <Icon name="ChevronLeft" className="size-[20px] shrink-0" />
            <span className="truncate">Back</span>
          </SheetItem>
          <div className="px-4 pb-1 pt-2 text-xs font-medium text-muted-foreground">
            {stepRow.choices.heading ?? stepRow.label}
          </div>
          {stepRow.choices.items.map((choice) => (
            <SheetItem
              key={choice.id}
              haptics={haptics}
              current={choice.selected}
              disabled={choice.disabled}
              onSelect={runAndClose(stepRow, choice.id)}
            >
              {choice.icon === undefined ? null : (
                <RegistryIcon name={choice.icon} aria-hidden className="size-[20px] shrink-0" />
              )}
              <ChoiceMarks choice={choice} />
            </SheetItem>
          ))}
          {stepRow.choices.hint === undefined ? null : (
            <>
              <hr className={SHEET_SEPARATOR_CLASS} />
              <div className="px-4 py-1 text-xs text-muted-foreground">{stepRow.choices.hint}</div>
            </>
          )}
        </>
      ) : (
        groups.map((group, index) => (
          <Fragment key={group[0]!.key}>
            {index > 0 && <hr className={SHEET_SEPARATOR_CLASS} />}
            {group.map((row) => (
              <SheetItem
                key={row.key}
                haptics={haptics}
                label={row.choices === undefined ? undefined : choiceRowName(row)}
                disabled={row.disabled}
                destructive={row.destructive}
                tall={hasDetailLine(row)}
                onSelect={row.choices === undefined ? runAndClose(row) : () => setStep(row.key)}
              >
                <span className={SHEET_ICON_CLASS}>{row.icon}</span>
                <RowLabel row={row} />
                {row.choices === undefined ? null : (
                  <Icon name="ChevronRight" className="ml-auto size-4 shrink-0 opacity-60" />
                )}
              </SheetItem>
            ))}
          </Fragment>
        ))
      )}
    </div>
  );
}

function SheetItem({
  haptics,
  label,
  current,
  disabled = false,
  destructive = false,
  tall = false,
  onSelect,
  children,
}: {
  haptics: boolean;
  label?: string;
  current?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  tall?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <div
      // iOS plays its tick only for a tap on a native switch, so each item
      // carries an invisible one (lib/ios-haptics).
      ref={(element) => {
        if (haptics) attachHapticTrigger(element);
        else element?.querySelector("[data-haptic-trigger]")?.remove();
      }}
      role="menuitem"
      tabIndex={-1}
      aria-label={label}
      aria-current={current ? "true" : undefined}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onSelect}
      onKeyDown={(event) => {
        if (disabled || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onSelect();
      }}
      className={cn(SHEET_ITEM_CLASS, tall && "py-2", destructive && "text-destructive-text")}
    >
      {children}
    </div>
  );
}

/**
 * Arrow, Home and End move focus between the sheet's enabled items. A touch
 * never needs them, but the sheet also opens under a mouse on a narrow
 * window. For the sheet's focus-trapping container, so the keys work
 * wherever in it focus rests, as after a choice list replaces the items.
 */
export function moveSheetFocus(event: KeyboardEvent<HTMLElement>) {
  const step = { ArrowDown: 1, ArrowUp: -1, Home: 0, End: 0 }[event.key];
  if (step === undefined) return;
  event.preventDefault();
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"])',
    ),
  );
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : index === -1
          ? step === 1
            ? 0
            : items.length - 1
          : (index + step + items.length) % items.length;
  items[next]?.focus();
}
