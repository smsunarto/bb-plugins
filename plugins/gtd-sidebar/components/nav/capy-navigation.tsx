// Sidebar navigation in Capy's list style: 28px rows of a 14px icon and a
// 13px medium label above the thread list, and Search as an icon in the
// sidebar header. bb owns the items, their order, and what each one does;
// this file only draws them.
import { memo, type MouseEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  experimental_SidebarNavigationIcon as NavigationIcon,
  experimental_useSidebarNavigation as useSidebarNavigation,
  experimental_useSidebarNavigationSplit as useSidebarNavigationSplit,
  type ExperimentalSidebarHeaderProps,
  type ExperimentalSidebarNavigationActions as NavigationActions,
  type ExperimentalSidebarNavigationItem as NavigationItem,
  type ExperimentalSidebarNavigationProps,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { Icon } from "../ui/icon";
import { MENU_ITEM_CLASS, MENU_MATERIAL_CLASS, MenuSurface } from "../inbox/menu-surface";

const SEARCH_ID = "__bb__/search-threads";

const ROW_CLASS = cn(
  "flex h-7 w-full min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-[6px] px-2",
  "text-left text-[13px] leading-none font-medium tracking-[-0.01em] text-sidebar-foreground",
  "outline-none select-none transition-colors duration-100",
  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  "focus-visible:ring-1 focus-visible:ring-sidebar-ring focus-visible:ring-inset",
  "disabled:cursor-default disabled:opacity-50",
  "aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground",
);

/** Modifier clicks open the destination in a browser tab, as in bb's own navigation. */
function activationTarget(event: MouseEvent): "current" | "tab" {
  return event.metaKey || event.ctrlKey || event.button === 1 ? "tab" : "current";
}

export function CapyNavigation(_props: ExperimentalSidebarNavigationProps) {
  const navigation = useSidebarNavigation();
  const { items, activeItemId, isShortcutModifierHeld, actions } = navigation;
  const hidden = items.filter((item) => !item.isVisible);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <nav aria-label="Navigation" className="flex shrink-0 flex-col gap-px px-2 py-1">
          {items.map((item) =>
            item.isVisible && item.id !== SEARCH_ID ? (
              <NavigationRow
                key={item.id}
                item={item}
                isActive={item.id === activeItemId}
                showShortcut={isShortcutModifierHeld}
                actions={actions}
              />
            ) : null,
          )}
          {hidden.length > 0 ? <MoreRow hidden={hidden} actions={actions} /> : null}
        </nav>
      </ContextMenu.Trigger>
      <MenuSurface>
        <ContextMenu.Item className={MENU_ITEM_CLASS} onSelect={() => actions.openCustomize()}>
          <Icon name="Settings" className="size-3.5" aria-hidden />
          Customize navigation…
        </ContextMenu.Item>
      </MenuSurface>
    </ContextMenu.Root>
  );
}

const NavigationRow = memo(function NavigationRow({
  item,
  isActive,
  showShortcut,
  actions,
}: {
  item: NavigationItem;
  isActive: boolean;
  showShortcut: boolean;
  actions: NavigationActions;
}) {
  const { splitProps } = useSidebarNavigationSplit(item.id);
  const { badge } = item;
  return (
    <button
      type="button"
      {...splitProps}
      // bb's own list rows carry the item id here; keyboard tools such as
      // Vimium find rows by it rather than by their translatable labels.
      data-sidebar-navigation-item={item.id}
      className={ROW_CLASS}
      disabled={item.isDisabled}
      aria-busy={item.isLoading || undefined}
      aria-current={isActive ? "page" : undefined}
      aria-label={badge === null ? undefined : `${item.label}, ${badge.label}`}
      aria-keyshortcuts={item.shortcut?.ariaKeyShortcuts}
      onClick={(event) => actions.activate(item.id, { target: activationTarget(event) })}
      onAuxClick={(event) => {
        if (event.button === 1) actions.activate(item.id, { target: "tab" });
      }}
    >
      <NavigationIcon icon={item.icon} className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {showShortcut && item.shortcut !== null ? (
        <kbd className="shrink-0 font-sans text-[11px] text-subtle-foreground">
          {item.shortcut.label}
        </kbd>
      ) : badge !== null ? (
        <span
          aria-hidden
          className="ml-auto flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-sidebar-accent px-1 text-[10px] font-semibold text-sidebar-accent-foreground tabular-nums"
        >
          {badge.count === undefined ? (badge.text ?? "•") : badge.count > 99 ? "99+" : badge.count}
        </span>
      ) : null}
    </button>
  );
});

/** Items the user hid stay reachable here, with the editor that unhides them. */
function MoreRow({ hidden, actions }: { hidden: NavigationItem[]; actions: NavigationActions }) {
  const portalScope = usePortalScopeProps();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" data-sidebar-navigation-more="" className={ROW_CLASS}>
          <Icon name="MoreHorizontal" className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">More</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...portalScope}
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-50 min-w-48 text-popover-foreground"
        >
          <div className={MENU_MATERIAL_CLASS}>
            {hidden.map((item) => (
              <DropdownMenu.Item
                key={item.id}
                disabled={item.isDisabled}
                className={MENU_ITEM_CLASS}
                onClick={(event) => actions.activate(item.id, { target: activationTarget(event) })}
              >
                <NavigationIcon icon={item.icon} className="size-3.5 shrink-0" />
                {item.label}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator className="mx-2 my-1 h-px bg-border" />
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => actions.openCustomize()}>
              <Icon name="Settings" className="size-3.5 shrink-0" aria-hidden />
              Customize navigation…
            </DropdownMenu.Item>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Capy keeps Search out of the list, as an icon at the right of the sidebar header. */
export function CapyNavigationHeader({ width, controlSize }: ExperimentalSidebarHeaderProps) {
  const { items, actions } = useSidebarNavigation();
  const search = items.find((item) => item.id === SEARCH_ID);
  if (search === undefined || width < controlSize) return <div className="flex-1" />;
  return (
    <div className="flex min-w-0 flex-1 items-center justify-end">
      <button
        type="button"
        aria-label={search.label}
        aria-keyshortcuts={search.shortcut?.ariaKeyShortcuts}
        title={
          search.shortcut === null ? search.label : `${search.label} (${search.shortcut.label})`
        }
        disabled={search.isDisabled}
        onClick={(event) => actions.activate(search.id, { target: activationTarget(event) })}
        style={{ width: controlSize, height: controlSize }}
        className={cn(
          "flex shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-sidebar-foreground",
          "outline-none transition-colors duration-100",
          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          "focus-visible:ring-1 focus-visible:ring-sidebar-ring focus-visible:ring-inset",
        )}
      >
        <NavigationIcon icon={search.icon} className="size-3.5" />
      </button>
    </div>
  );
}
