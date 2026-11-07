import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { BotMetadata, BotsActions } from "@smsunarto/bb-plugin-bots/shelf";
import { ready } from "../../../.storybook/ready";
import { BotCardGrid, type BotCardSummary } from "../components/inbox/bot-cards";
import "../app.css";
import "../bot-shelf.css";
import "../../bots/bots.css";

function bot(
  id: string,
  name: string,
  role: string,
  avatar: BotMetadata["avatar"],
  order: number,
): BotMetadata {
  return {
    id,
    name,
    role,
    avatar,
    hostId: "host_story",
    stateReady: true,
    legacyHomeProjectId: null,
    linkedProjectIds: [],
    mainThreadId: null,
    hiddenUntilActivity: false,
    hiddenAt: null,
    sectionId: null,
    order,
    soul: "",
    agents: "",
    memory: "",
    settings: {},
    stateHashes: { "SOUL.md": null, "AGENTS.md": null, "MEMORY.md": null, "settings.json": null },
    updatedAt: 1792670400000,
    legacyProjectId: null,
  };
}

const bots = [
  bot(
    "bot_ada",
    "Ada",
    "Reviews PRs, keeps CI green",
    { color: "#6d5efc", shape: "round", expression: "curious", motion: "calm" },
    0,
  ),
  bot(
    "bot_juno",
    "Juno",
    "Triages inbox and calendar",
    { color: "#168b75", shape: "squircle", expression: "happy", motion: "playful" },
    1,
  ),
  bot(
    "bot_rex",
    "Rex",
    "Ships game builds nightly",
    { color: "#cb7428", shape: "blob", expression: "focused", motion: "calm" },
    2,
  ),
  bot(
    "bot_mira",
    "Mira",
    "Research and long reads, with a role long enough to clamp",
    { color: "#e152b0", shape: "cloud", expression: "neutral", motion: "still" },
    3,
  ),
];

const summaries = new Map<string, BotCardSummary>([
  ["bot_ada", { families: 4, attention: 2, completed: 3, working: false }],
  ["bot_juno", { families: 2, attention: 0, completed: 0, working: false }],
  ["bot_rex", { families: 7, attention: 0, completed: 1, working: true }],
  ["bot_mira", { families: 0, attention: 0, completed: 0, working: false }],
]);

const actions: BotsActions = {
  createBot: fn(),
  editBot: fn(),
  newConversation: fn(),
  newInProject: fn(),
  fork: fn(),
  setHidden: fn(),
  setCompleted: fn(),
  move: fn(),
  hasWorkProjects: () => true,
};

const meta = {
  title: "Components/GTD Sidebar/Bot cards",
  component: BotCardGrid,
  tags: ["autodocs"],
  play: ready,
  decorators: [
    (Story) => (
      <div data-gtd-sidebar-thread-list="" style={{ width: 288, padding: 8 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    bots,
    summaries,
    threadsByBot: new Map(),
    selectedBotId: "bot_ada",
    activeBotId: "bot_ada",
    showingCompleted: new Set(),
    onSelect: fn(),
    onOpenLatest: fn(),
    onToggleCompleted: fn(),
    actions,
    isCompactViewport: false,
  },
} satisfies Meta<typeof BotCardGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Grid: Story = {};

/** A narrow panel stacks the cards one across. */
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 200 }}>
        <Story />
      </div>
    ),
  ],
};
