// @smsunarto/bb-plugin-gtd-sidebar — an action-oriented replacement for bb's
// sidebar thread list, and a reference for `app.slots.experimental_threadList`.
//
// Active threads are grouped by who acts next. Every section orders by when
// each thread arrived on it, most recent first.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { ThreadInbox } from "./components/inbox/thread-inbox";
import { CapyNavigation } from "./components/nav/capy-navigation";
import { mountSearchCustomizeStyle } from "./components/nav/search-customize-style";
import { archiveThread, hasSidebarActions } from "./lib/sidebar-actions-bridge";
import {
  HeaderSettle,
  type LegacyThreadHeaderActionSlots,
} from "./components/header/header-settle";
import { mountHeaderSettleStyle } from "./components/header/header-settle-style";
import { mountPhoneDrawer } from "./lib/phone-drawer";

export default definePluginApp((app) => {
  // Versions up to 0.4.x cached the shelves and provider marks in web storage,
  // which bb's uninstall never clears. Drop those entries on the way in.
  try {
    for (const key of ["gtd-sidebar:v1:lifecycle-rows", "gtd-sidebar:v1:providers"]) {
      localStorage.removeItem(key);
    }
  } catch {
    // No web storage here, so nothing was ever left behind.
  }

  app.slots.experimental_threadList({
    id: "inbox",
    title: "GTD Sidebar (inbox)",
    description: "Next Action and Waiting, with the newest arrivals first.",
    component: ThreadInbox,
  });

  app.slots.experimental_sidebarNavigation({
    id: "capy-list",
    title: "GTD Sidebar (Capy list)",
    description: "Capy-style rows above the thread list, Search included.",
    placement: "list",
    component: CapyNavigation,
  });

  // Search is always a row, so its checkbox in bb's Customize navigation
  // editor would do nothing.
  app.contentScripts.register({
    id: "search-customize-style",
    mount: ({ signal }) => mountSearchCustomizeStyle(document, signal),
  });

  // On a phone, New thread and Settle join the header; Settle takes the place
  // of bb's "…" thread menu.
  (app.slots as unknown as LegacyThreadHeaderActionSlots).experimental_threadHeaderAction({
    id: "header-settle",
    title: "Thread shortcuts",
    component: HeaderSettle,
  });
  app.contentScripts.register({
    id: "header-settle-style",
    mount: ({ signal }) => mountHeaderSettleStyle(document, signal),
  });

  app.slots.commandPaletteAction({
    id: "settle-thread",
    title: "GTD Sidebar: settle thread",
    isAvailable: ({ threadId }) => threadId !== null && hasSidebarActions(),
    run: ({ threadId }) => {
      if (threadId !== null) archiveThread(threadId);
    },
  });

  // The phone drawer dismisses the keyboard as it opens and plays a light
  // haptic once fully open.
  app.contentScripts.register({
    id: "phone-drawer",
    mount: ({ signal }) => mountPhoneDrawer(document, signal),
  });
});
