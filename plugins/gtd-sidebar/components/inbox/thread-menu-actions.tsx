import { Fragment, useState, type ReactNode } from "react";
import {
  experimental_Icon as RegistryIcon,
  experimental_useThreadActions as useThreadActions,
  useSettings,
  type PluginSidebarThread,
  type PluginThreadActionChoices,
  type PluginThreadActionEntry,
} from "@get-bb/plugin-sdk/app";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";
import { attachHapticTrigger } from "../../lib/ios-haptics";
import { ARCHIVE_ACTION_KEY, toThreadActionTarget } from "../../lib/thread-action-target";
import type { ThreadActionPlan } from "./thread-actions";
import type { ThreadRename } from "./inline-rename";
import { MENU_ITEM_CLASS, MenuSubSurface } from "./menu-surface";

export interface ThreadMenuActionsProps {
  thread: PluginSidebarThread;
  /** The row's GTD lifecycle moves, which lead the menu. */
  plan: ThreadActionPlan;
  rename: ThreadRename;
}

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

const COMPACT_ITEM_CLASS =
  "relative flex h-[44px] cursor-default select-none items-center gap-3.5 px-4 text-[16px] font-normal leading-none tracking-[-0.01em] outline-none data-[highlighted]:bg-state-hover active:bg-state-active data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
const COMPACT_DETAIL_ITEM_CLASS = "h-auto min-h-[44px] py-2";

/**
 * One action order for the desktop and compact row menus: the GTD lifecycle
 * moves, then every action in bb's thread action registry — bb's own split,
 * copy link, pin, read, rename and delete, and other plugins' (per-thread
 * notifications, say) — grouped the way bb's own thread menu groups them.
 * bb's Archive is left out: Settle and Un-settle stand in for it.
 *
 * Mounted only while its menu is open, so a row holds no registry
 * subscription of its own.
 */
export function ThreadMenuActions({
  thread,
  plan,
  rename,
  compact = false,
  haptics = true,
  closeMenu,
}: ThreadMenuActionsProps & { compact?: boolean; haptics?: boolean; closeMenu?: () => void }) {
  const { values } = useSettings();
  const entries = useThreadActions(toThreadActionTarget(thread), {
    requestRename: () => rename.startEditingFromMenu(closeMenu),
  });
  // A compact menu shows one choice list at a time in place of the menu,
  // with Back, as bb's own drawer does.
  const [step, setStep] = useState<string | null>(null);
  const Menu = compact ? DropdownMenu : ContextMenu;
  const groups = menuGroups(plan, entries);
  const itemRef = compact
    ? (element: HTMLElement | null) => {
        if (haptics && values?.mobileHaptics === true) attachHapticTrigger(element);
        else element?.querySelector("[data-haptic-trigger]")?.remove();
      }
    : undefined;
  const itemClass = (row: Pick<MenuRow, "destructive" | "detail" | "choices">) =>
    cn(
      compact ? COMPACT_ITEM_CLASS : MENU_ITEM_CLASS,
      // Only a plain action draws its detail as a second line.
      compact && row.detail !== undefined && row.choices === undefined && COMPACT_DETAIL_ITEM_CLASS,
      row.destructive ? "text-destructive-text" : "data-[highlighted]:text-accent-foreground",
    );
  const iconClass = compact ? "size-[20px] shrink-0" : "size-4 shrink-0";

  const stepRow = step === null ? undefined : groups.flat().find((row) => row.key === step);
  if (compact && stepRow?.choices !== undefined) {
    return (
      <CompactChoiceStep
        row={stepRow}
        choices={stepRow.choices}
        itemRef={itemRef}
        itemClass={itemClass({})}
        iconClass={iconClass}
        onBack={() => setStep(null)}
      />
    );
  }

  return groups.map((group, index) => (
    <Fragment key={group[0]!.key}>
      {index > 0 && <Menu.Separator className="mx-2 my-1.5 h-px bg-border" />}
      {group.map((row) => {
        const content = (
          <>
            <span className={cn("flex items-center justify-center", iconClass)}>{row.icon}</span>
            <RowLabel row={row} />
          </>
        );
        if (row.choices === undefined) {
          return (
            <Menu.Item
              key={row.key}
              ref={itemRef}
              disabled={row.disabled}
              onSelect={() => row.run()}
              className={itemClass(row)}
            >
              {content}
            </Menu.Item>
          );
        }
        if (compact) {
          return (
            <DropdownMenu.Item
              key={row.key}
              ref={itemRef}
              aria-label={choiceRowName(row)}
              disabled={row.disabled}
              onSelect={(event) => {
                event.preventDefault();
                setStep(row.key);
              }}
              className={itemClass(row)}
            >
              {content}
              <Icon name="ChevronRight" className="ml-auto size-4 shrink-0 opacity-60" />
            </DropdownMenu.Item>
          );
        }
        return (
          <ContextMenu.Sub key={row.key}>
            <ContextMenu.SubTrigger
              aria-label={choiceRowName(row)}
              disabled={row.disabled}
              className={cn(itemClass(row), "data-[state=open]:bg-accent")}
            >
              {content}
              <Icon name="ChevronRight" className="ml-auto size-3.5 shrink-0 opacity-60" />
            </ContextMenu.SubTrigger>
            <MenuSubSurface
              aria-label={row.choices.heading ?? row.label}
              aria-labelledby={undefined}
            >
              <ChoiceItems
                Menu={ContextMenu}
                row={row}
                choices={row.choices}
                itemClass={itemClass({})}
                iconClass={iconClass}
              />
            </MenuSubSurface>
          </ContextMenu.Sub>
        );
      })}
    </Fragment>
  ));
}

/** A choice row's name: its label, then the current value, as bb's menu reads it. */
function choiceRowName(row: MenuRow): string | undefined {
  return row.detail === undefined ? undefined : `${row.label}, ${row.detail}`;
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

/**
 * The label, and under it the action's detail on a muted line. A row with a
 * choice list shows only its label; `choiceRowName` reads the detail out.
 */
function RowLabel({ row }: { row: MenuRow }) {
  if (row.detail === undefined || row.choices !== undefined) {
    return <span className="min-w-0 truncate">{row.label}</span>;
  }
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate">{row.label}</span>
      <span className="truncate text-2xs text-muted-foreground">{row.detail}</span>
    </span>
  );
}

function ChoiceItems({
  Menu,
  row,
  choices,
  itemRef,
  itemClass,
  iconClass,
}: {
  Menu: typeof ContextMenu | typeof DropdownMenu;
  row: MenuRow;
  choices: PluginThreadActionChoices;
  itemRef?: (element: HTMLElement | null) => void;
  itemClass: string;
  iconClass: string;
}) {
  return (
    <>
      {choices.items.map((choice) => (
        <Menu.Item
          key={choice.id}
          ref={itemRef}
          aria-current={choice.selected ? "true" : undefined}
          disabled={choice.disabled}
          onSelect={() => row.run(choice.id)}
          className={itemClass}
        >
          {choice.icon === undefined ? null : (
            <RegistryIcon name={choice.icon} aria-hidden className={iconClass} />
          )}
          <span className="min-w-0 flex-1 truncate">{choice.label}</span>
          {choice.selected ? <Icon name="Check" className="ml-auto size-4 shrink-0" /> : null}
        </Menu.Item>
      ))}
      {choices.hint === undefined ? null : (
        <>
          <Menu.Separator className="mx-2 my-1.5 h-px bg-border" />
          <div className="max-w-56 px-2 py-1 text-xs text-muted-foreground">{choices.hint}</div>
        </>
      )}
    </>
  );
}

/** A choice list in place of the compact menu, with Back to return to it. */
function CompactChoiceStep({
  row,
  choices,
  itemRef,
  itemClass,
  iconClass,
  onBack,
}: {
  row: MenuRow;
  choices: PluginThreadActionChoices;
  itemRef?: (element: HTMLElement | null) => void;
  itemClass: string;
  iconClass: string;
  onBack: () => void;
}) {
  return (
    <>
      <DropdownMenu.Item
        ref={itemRef}
        onSelect={(event) => {
          event.preventDefault();
          onBack();
        }}
        className={itemClass}
      >
        <Icon name="ChevronLeft" className={iconClass} />
        <span className="truncate">Back</span>
      </DropdownMenu.Item>
      <DropdownMenu.Label className="px-4 pb-1 pt-2 text-xs font-medium text-muted-foreground">
        {choices.heading ?? row.label}
      </DropdownMenu.Label>
      <ChoiceItems
        Menu={DropdownMenu}
        row={row}
        choices={choices}
        itemRef={itemRef}
        itemClass={itemClass}
        iconClass={iconClass}
      />
    </>
  );
}
