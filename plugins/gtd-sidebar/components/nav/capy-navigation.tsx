// Sidebar navigation in Capy's list style: 28px rows of a 14px icon and a
// 13px medium label above the thread list, Search included. bb owns the
// items, their order, and what each one does; this file only draws them.
import { memo, useRef, type MouseEvent } from "react";
import {
  experimental_ShortcutHint as ShortcutHint,
  experimental_SidebarNavigationIcon as NavigationIcon,
  experimental_useSidebarNavigation as useSidebarNavigation,
  experimental_useSidebarNavigationSplit as useSidebarNavigationSplit,
  type ExperimentalSidebarNavigationActions as NavigationActions,
  type ExperimentalSidebarNavigationItem as NavigationItem,
  type ExperimentalSidebarNavigationProps,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import {
  ContextMenu,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Icon } from "../ui/icon";
import { MenuSurface } from "../inbox/menu-surface";

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
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <nav aria-label="Navigation" className="flex shrink-0 flex-col px-2 py-1">
          {items.map((item) =>
            item.isVisible ? (
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
      </ContextMenuTrigger>
      <MenuSurface>
        <ContextMenuGroup>
          <ContextMenuItem onSelect={() => actions.openCustomize()}>
            <Icon name="Settings" className="size-3.5" aria-hidden />
            Customize navigation…
          </ContextMenuItem>
        </ContextMenuGroup>
      </MenuSurface>
    </ContextMenu>
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
        <ShortcutHint
          shortcut={{
            label: item.shortcut.label,
            ariaKeyshortcuts: item.shortcut.ariaKeyShortcuts,
          }}
          className="shrink-0"
        />
      ) : badge !== null ? (
        <Badge variant="count" aria-hidden className="ml-auto min-w-4 justify-center">
          {badge.count === undefined ? (badge.text ?? "•") : badge.count > 99 ? "99+" : badge.count}
        </Badge>
      ) : null}
    </button>
  );
});

/** Items the user hid stay reachable here, with the editor that unhides them. */
function MoreRow({ hidden, actions }: { hidden: NavigationItem[]; actions: NavigationActions }) {
  // A pick runs on select, the one event every input and the phone sheet
  // fire; the click before it, when there is one, says whether a modifier
  // asked for a browser tab.
  const target = useRef<"current" | "tab">("current");
  const activate = (id: string) => {
    actions.activate(id, { target: target.current });
    target.current = "current";
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-sidebar-navigation-more="" className={ROW_CLASS}>
          <Icon name="MoreHorizontal" className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">More</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" mobileTitle="More" className="min-w-48">
        <DropdownMenuGroup>
          {hidden.map((item) => (
            <DropdownMenuItem
              key={item.id}
              disabled={item.isDisabled}
              onClick={(event) => {
                target.current = activationTarget(event);
              }}
              onSelect={() => activate(item.id)}
            >
              <NavigationIcon icon={item.icon} className="size-3.5 shrink-0" />
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => actions.openCustomize()}>
            <Icon name="Settings" className="size-3.5 shrink-0" aria-hidden />
            Customize navigation…
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
