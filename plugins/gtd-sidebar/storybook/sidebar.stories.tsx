import type { Meta, StoryObj } from "@storybook/react-vite";
import { shows } from "../../../.storybook/ready";
import { RegisteredSurface } from "../../../.storybook/host";
import { makePluginProject, makeSidebarThread } from "../app/model/fixtures";
import { defaultPreferences } from "../shared/preferences";

const source = () => import("../app");
const HOUR = 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 2, 17, 0);
const laptop = { id: "host_laptop", name: "Laptop" };
const server = { id: "host_server", name: "Build server" };
const projects = [
  makePluginProject({ id: "proj_atlas", name: "Atlas" }),
  makePluginProject({ id: "proj_docs", name: "Docs" }),
];
const at = (hoursAgo: number) => now - hoursAgo * HOUR;
const threads = [
  makeSidebarThread({
    id: "thr_pinned",
    projectId: "proj_atlas",
    title: "Release checklist",
    displayTitle: "Release checklist",
    isPinned: true,
    pinnedAt: at(30),
    host: laptop,
    updatedAt: at(1),
  }),
  makeSidebarThread({
    id: "thr_review",
    projectId: "proj_atlas",
    title: "Review the reconnect fix",
    displayTitle: "Review the reconnect fix",
    isUnread: true,
    indicator: "unread-success",
    host: laptop,
    latestAttentionAt: at(0.5),
    updatedAt: at(0.5),
  }),
  makeSidebarThread({
    id: "thr_child",
    projectId: "proj_atlas",
    parentThreadId: "thr_review",
    title: "Add a regression test",
    displayTitle: "Add a regression test",
    host: laptop,
    updatedAt: at(0.4),
  }),
  makeSidebarThread({
    id: "thr_working",
    projectId: "proj_docs",
    title: "Draft the migration guide",
    displayTitle: "Draft the migration guide",
    indicator: "runtime",
    runtimeStatus: "running",
    status: "active",
    host: server,
    updatedAt: at(0.1),
  }),
  makeSidebarThread({
    id: "thr_settled",
    projectId: "proj_docs",
    title: "Fix broken links",
    displayTitle: "Fix broken links",
    isArchived: true,
    archivedAt: at(2),
    host: laptop,
    updatedAt: at(2),
  }),
];

const meta = {
  title: "Screens/GTD Sidebar/Sidebar",
  component: RegisteredSurface,
  play: shows("Next Action"),
  args: {
    source,
    select: (app) => {
      const List = app.threadLists[0]?.component;
      if (!List) throw new Error("Missing thread list registration");
      return (
        <div style={{ width: 300 }}>
          <List
            activeThreadId={null}
            activeProjectId={null}
            isCompactViewport={false}
            onNavigate={() => {}}
            searchQuery=""
          />
        </div>
      );
    },
  },
  parameters: {
    host: {
      pluginId: "gtd-sidebar",
      sidebarThreads: { threads, projects },
      rpc: {
        listPreferences: () => ({ preferences: defaultPreferences() }),
        listLifecycle: () => ({ rows: [] }),
        listMachineVisibility: () => ({ hiddenMachineIds: [] }),
        listNamingThreads: () => ["thr_child"],
      },
      sdk: {
        system: { config: async () => ({ primaryHostId: laptop.id }) },
        hosts: { list: async () => [] },
        subscribe: () => () => {},
      },
    },
  },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Shelves: Story = {};
