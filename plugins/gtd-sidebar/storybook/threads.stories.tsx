import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { fn } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { ThreadCard } from "../components/inbox/thread-card";
import { RenameProvider } from "../components/inbox/inline-rename";
import "../app.css";
const thread: PluginSidebarThread = {
  id: "thr_story",
  projectId: "proj_story",
  title: "Review component states",
  titleFallback: null,
  parentThreadId: null,
  sectionId: null,
  originKind: null,
  originPluginId: null,
  providerId: "codex",
  hasPendingInteraction: false,
  activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
  indicator: "none",
  indicatorLabel: null,
  isUnread: false,
  isPinned: false,
  isArchived: false,
  environment: null,
  host: null,
  displayTitle: "Review component states",
  lifecycleOwnerThreadId: null,
  sourceThreadId: null,
  status: "idle",
  runtimeStatus: "idle",
  queuedWork: "none",
  pinnedAt: null,
  pinSortKey: null,
  archivedAt: null,
  href: "#",
  isHidden: false,
  createdAt: 1792670400000,
  updatedAt: 1792670400000,
  lastReadAt: 1792670400000,
  latestAttentionAt: 1792670400000,
};
const meta = {
  title: "Components/GTD Sidebar/Thread cards",
  component: ThreadCard,
  tags: ["autodocs"],
  play: ready,
  decorators: [
    (Story) => (
      <RenameProvider renameThread={async () => {}}>
        <div style={{ width: "100%", maxWidth: 360 }}>
          <Story />
        </div>
      </RenameProvider>
    ),
  ],
  args: {
    thread,
    statusThread: thread,
    isUnread: false,
    shelf: "nextAction",
    compactThreads: false,
    depth: 0,
    parentId: null,
    parentTitle: null,
    childCount: 0,
    expanded: false,
    guides: "",
    lastChild: true,
    toggleThread: fn(),
    projectName: "bb-plugins",
    branchName: "scott/storybook-mcp",
    isActive: false,
    canPark: true,
    showProviderIcon: true,
    isCompactViewport: false,
    command: fn(),
    dropAllowed: false,
  },
} satisfies Meta<typeof ThreadCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Idle: Story = {};
export const Selected: Story = { args: { isActive: true } };
export const Unread: Story = { args: { isUnread: true } };
export const Working: Story = {
  args: {
    shelf: "waiting",
    canPark: false,
    statusThread: {
      ...thread,
      indicator: "runtime",
      indicatorLabel: "Working",
      status: "active",
      runtimeStatus: "active",
    },
  },
};
export const NeedsInput: Story = {
  args: {
    shelf: "waiting",
    statusThread: { ...thread, indicator: "waiting-for-input", indicatorLabel: "Needs input" },
  },
};
export const WithChildren: Story = { args: { childCount: 3, expanded: true } };
export const Compact: Story = { args: { compactThreads: true, isCompactViewport: true } };
export const LongTitle: Story = {
  args: {
    thread: {
      ...thread,
      displayTitle:
        "Review every loading, empty, stale, offline and recovery state across all custom plugin components",
    },
  },
};
