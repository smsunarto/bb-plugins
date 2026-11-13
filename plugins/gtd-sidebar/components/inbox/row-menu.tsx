import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type MouseEvent,
} from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { useIosLongPress, type LongPress } from "../../hooks/use-ios-long-press";
import { openRowContextMenu, RowContextMenu } from "./row-context-menu";
import { captureSheetOrigin, ThreadActionSheet, type SheetOrigin } from "./thread-action-menu";
import type { ThreadActionPlan } from "./thread-actions";

/** What the menu needs to act on a row, resolved by the list from a thread id. */
export interface RowMenuTarget {
  thread: PluginSidebarThread;
  /** The row's GTD lifecycle moves, which lead the menu. */
  plan: ThreadActionPlan;
}

/** How a row is involved with the menu, which the row draws as a fill. */
export type RowMenuState = "pressed" | "open" | null;

interface RowMenuStore {
  /** The row under a resting finger or a held mouse button. */
  pressedId: string | null;
  /** The row whose menu is open. */
  openId: string | null;
}

const RowMenuContext = createContext<StoreApi<RowMenuStore> | null>(null);

/**
 * A row's part in the list's menu. Each row selects only its own answer, so
 * a press or an open menu redraws that row and no other.
 */
export function useRowMenuState(threadId: string): RowMenuState {
  const store = useContext(RowMenuContext);
  if (store === null) throw new Error("useRowMenuState needs a RowMenuArea");
  return useStore(store, (state) =>
    state.openId === threadId ? "open" : state.pressedId === threadId ? "pressed" : null,
  );
}

/** The attribute a row puts on its own element so the list can find it. */
export const ROW_MENU_ATTRIBUTE = "data-gtd-menu-row";

function rowOf(element: Element): HTMLElement | null {
  const row = element.closest<HTMLElement>(`[${ROW_MENU_ATTRIBUTE}]`);
  // A row being renamed keeps its gestures for the editor.
  return row === null || row.querySelector("[data-sidebar-rename-editor]") ? null : row;
}

/**
 * The list's scroll container, and the one menu every row in it shares.
 *
 * A menu per row cost each row a Radix root — a document key listener, a
 * popper and a dozen contexts apiece, twice over on a compact viewport — for
 * a menu that opens on one row at a time. Here the container hears the
 * right-click or the long press, finds the row under it, and opens the one
 * desktop menu or touch sheet for that thread. Rows only mark themselves
 * (`ROW_MENU_ATTRIBUTE`) and draw the state `useRowMenuState` reports.
 *
 * The state lives here, not in the list, so opening a menu redraws this
 * component and the two rows involved while the list's rows stay as they are.
 */
export function RowMenuArea({
  resolveTarget,
  isCompactViewport,
  children,
  ...container
}: {
  /** The row's thread and plan as the list has them now, or null once it is gone. */
  resolveTarget: (threadId: string) => RowMenuTarget | null;
  isCompactViewport: boolean;
} & ComponentPropsWithRef<"div">) {
  const [store] = useState(() =>
    createStore<RowMenuStore>(() => ({ pressedId: null, openId: null })),
  );
  const [menu, setMenu] = useState<
    | { kind: "context"; threadId: string }
    | { kind: "sheet"; threadId: string; origin: SheetOrigin; open: boolean }
    | null
  >(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  // Remounts the desktop menu, which Radix gives no other way to close.
  const [contextMenuKey, setContextMenuKey] = useState(0);

  const target = menu === null ? null : resolveTarget(menu.threadId);
  const sheet = menu?.kind === "sheet" ? menu : null;
  const sheetOpen = sheet?.open === true && target !== null && isCompactViewport;

  const openContextMenu = (threadId: string, x: number, y: number) => {
    setMenu({ kind: "context", threadId });
    store.setState({ openId: threadId });
    openRowContextMenu(triggerRef.current, x, y);
  };
  const closeSheet = () => {
    setMenu((current) => (current?.kind === "sheet" ? { ...current, open: false } : current));
    store.setState({ openId: null });
  };

  // A menu whose thread left the list, or a sheet on a viewport that stopped
  // being compact, has nothing left to act on. Dropped while rendering, so no
  // frame draws it; remounting is the one way to close Radix's context menu.
  if (menu !== null && (target === null || (sheet !== null && !isCompactViewport))) {
    setMenu(null);
    setContextMenuKey((key) => key + 1);
  }
  const hasMenu = menu !== null;
  useEffect(() => {
    if (!hasMenu) store.setState({ openId: null });
  }, [hasMenu, store]);

  const longPress = useIosLongPress<HTMLElement>(
    ({ target: row, x, y }: LongPress<HTMLElement>) => {
      const threadId = row.getAttribute(ROW_MENU_ATTRIBUTE)!;
      if (!isCompactViewport) return openContextMenu(threadId, x, y);
      // Photographed before the row hides under its lifted copy.
      const origin = captureSheetOrigin(row);
      setMenu({ kind: "sheet", threadId, origin, open: true });
      store.setState({ openId: threadId });
    },
    {
      resolve: rowOf,
      // A wide touch screen has no right-click, so a hold opens the desktop
      // menu there. A mouse holds only where the sheet is the one menu.
      mouse: isCompactViewport,
      onPressChange: (row) =>
        store.setState({ pressedId: row?.getAttribute(ROW_MENU_ATTRIBUTE) ?? null }),
    },
  );

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    container.onContextMenu?.(event);
    // A project header's own menu has taken it.
    if (event.defaultPrevented) return;
    const row = rowOf(event.target as Element);
    if (row === null) return;
    event.preventDefault();
    // Android reports its own long press this way; the hold above answers it.
    if (isCompactViewport) return;
    openContextMenu(row.getAttribute(ROW_MENU_ATTRIBUTE)!, event.clientX, event.clientY);
  };

  return (
    <RowMenuContext.Provider value={store}>
      <div {...container} {...longPress} onContextMenu={onContextMenu}>
        {children}
      </div>
      <RowContextMenu
        key={contextMenuKey}
        target={menu?.kind === "context" ? target : null}
        triggerRef={triggerRef}
        onOpenChange={(open) => {
          if (!open) store.setState({ openId: null });
        }}
      />
      {sheet !== null && target !== null ? (
        <ThreadActionSheet
          target={target}
          origin={sheet.origin}
          open={sheetOpen}
          onOpenChange={(open) => {
            if (!open) closeSheet();
          }}
        />
      ) : null}
    </RowMenuContext.Provider>
  );
}
