// @smsunarto/bb-plugin-gtd-sidebar — an action-oriented replacement for bb's
// sidebar thread list, and a reference for `app.slots.experimental_threadList`.
//
// Active threads are grouped by who acts next. Every section orders by when
// each thread arrived on it, most recent first.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { ThreadInbox } from "./components/inbox/thread-inbox";
import { mountNewThreadFabStyle } from "./components/inbox/new-thread-fab-style";
import { CapyNavigation } from "./components/nav/capy-navigation";
import { archiveThread, canSettleThread } from "./lib/sidebar-actions-bridge";
import {
  HeaderSettle,
  type LegacyThreadHeaderActionSlots,
} from "./components/header/header-settle";
import { mountHeaderSettleStyle } from "./components/header/header-settle-style";
import { cancelComposeKeyboardHandoff } from "./lib/compose-keyboard";
import { mountPhoneDrawer } from "./lib/phone-drawer";
import { mountPhoneDrawerStyle } from "./lib/phone-drawer-style";

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

  // On a phone the thread list floats a New thread pill in place of bb's
  // New thread navigation row.
  app.contentScripts.register({
    id: "new-thread-fab-style",
    mount: ({ signal }) => mountNewThreadFabStyle(document, signal),
  });

  app.slots.commandPaletteAction({
    id: "settle-thread",
    title: "GTD Sidebar: settle thread",
    // Hidden on a thread that stays open, such as a Captain (lib/long-lived).
    isAvailable: ({ threadId }) => threadId !== null && canSettleThread(threadId),
    run: ({ threadId }) => {
      if (threadId !== null) archiveThread(threadId);
    },
  });

  // The phone drawer dismisses the keyboard as it opens and plays a light
  // haptic once fully open.
  app.contentScripts.register({
    id: "phone-drawer",
    mount: ({ signal }) => {
      const disposeEffects = mountPhoneDrawer(document, signal);
      const disposeStyle = mountPhoneDrawerStyle(document, signal);
      return () => {
        cancelComposeKeyboardHandoff(document);
        disposeEffects();
        disposeStyle();
      };
    },
  });
});
