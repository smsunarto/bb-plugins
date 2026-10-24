import { definePluginApp, experimental_THREAD_INFO_SECTION_GROUPS } from "@get-bb/plugin-sdk/app";
import { TasksAppShell } from "./shell/app-shell.js";
import { useTasksBadge } from "./shell/badge.js";
import { TasksNavigationPanel } from "./shell/navigation-panel.js";
import { TaskDirectiveCard, TaskEmbedPanel } from "./views/embed/index.js";
import { TasksThreadInfoSection } from "./views/embed/thread-info.js";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "tasks",
    title: "Tasks",
    icon: "ListTodo",
    path: "tasks",
    component: TasksAppShell,
    experimental_useBadge: useTasksBadge,
  });
  app.slots.experimental_tab({
    context: { kind: "nav-panel", panelId: "tasks" },
    availability: "fixed",
    id: "navigation",
    title: "Navigation",
    icon: "ListView",
    component: TasksNavigationPanel,
    layout: "flush",
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "task",
    title: "Task",
    icon: "ListTodo",
    component: TaskEmbedPanel,
  });
  app.slots.experimental_threadInfoSection({
    id: "tasks",
    group: experimental_THREAD_INFO_SECTION_GROUPS.related,
    // Before bb's child threads (10) and forks (20): the task is what this thread works on.
    order: 5,
    component: TasksThreadInfoSection,
  });
  app.slots.messageDirective({ id: "task", component: TaskDirectiveCard });
});
