// @smsunarto/bb-plugin-gtd-sidebar — an action-oriented replacement for bb's
// sidebar thread list, and a reference for `app.slots.experimental_threadList`.
//
// Active threads are grouped by who acts next. Every section orders by when
// each thread arrived on it, most recent first.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { ThreadInbox } from "@/components/inbox/thread-inbox";
import { ProjectsPage } from "@/components/projects/projects-page";
import { ProjectHeaderAction } from "@/components/projects/header-action";
import { ProjectPanel } from "@/components/projects/project-panel";
import { ProjectToolbar } from "@/components/projects/toolbar";
import { archiveThread, hasSidebarActions } from "@/lib/sidebar-actions-bridge";

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

  // Projects ("initiatives" internally): the management index + create form
  // live on their own navPanel page; live project chrome attaches to the
  // coordinator's native thread route through the three slots below.
  app.slots.navPanel({
    id: "projects",
    title: "Projects",
    icon: "Layers",
    path: "projects",
    component: ProjectsPage,
  });

  app.slots.experimental_threadHeaderAction({
    id: "project",
    title: "Project",
    component: ProjectHeaderAction,
  });

  app.slots.threadPanelAction({
    id: "project",
    title: "Project",
    icon: "Layers",
    layout: "flush",
    component: ProjectPanel,
    run: ({ openPanel }) => {
      openPanel({ title: "Project" });
    },
  });

  app.composer.customize({
    id: "project-toolbar",
    scopes: ["thread"],
    banners: [
      {
        id: "project-toolbar",
        chrome: "bare",
        component: ProjectToolbar,
      },
    ],
  });

  app.slots.commandPaletteAction({
    id: "settle-thread",
    title: "GTD Sidebar: settle thread",
    isAvailable: ({ threadId }) => threadId !== null && hasSidebarActions(),
    run: ({ threadId }) => {
      if (threadId !== null) archiveThread(threadId);
    },
  });
});
