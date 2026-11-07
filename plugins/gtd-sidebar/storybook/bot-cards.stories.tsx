import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { BotMetadata, BotsActions } from "@smsunarto/bb-plugin-bots/shelf";
import { ready } from "../../../.storybook/ready";
import { BotRow, PinnedBotGrid, botShelves, type BotSummary } from "../components/inbox/bot-cards";
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
    homeProjectId: null,
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

const sections = [{ id: "sec_research", name: "Research", order: 0 }];

const bots: BotMetadata[] = [
  {
    ...bot(
      "bot_ada",
      "Ada",
      "Reviews PRs",
      { color: "#6d5efc", shape: "round", expression: "curious", motion: "calm" },
      0,
    ),
    pinned: true,
  },
  {
    ...bot(
      "bot_juno",
      "Juno",
      "Triages inbox",
      { color: "#168b75", shape: "squircle", expression: "happy", motion: "playful" },
      1,
    ),
    pinned: true,
  },
  {
    ...bot(
      "bot_rex",
      "Rex",
      "Ships builds",
      { color: "#cb7428", shape: "blob", expression: "focused", motion: "calm" },
      2,
    ),
    pinned: true,
  },
  {
    ...bot(
      "bot_mira",
      "Mira",
      "Long reads",
      { color: "#e152b0", shape: "cloud", expression: "neutral", motion: "still" },
      3,
    ),
    pinned: true,
  },
  {
    ...bot(
      "bot_nova",
      "Nova",
      "Release notes",
      { color: "#66d9ef", shape: "round", expression: "happy", motion: "calm" },
      4,
    ),
    pinned: true,
  },
  {
    ...bot(
      "bot_otto",
      "Otto-with-a-very-long-name",
      "Deps",
      { color: "#a6e22e", shape: "squircle", expression: "neutral", motion: "still" },
      5,
    ),
    pinned: true,
  },
  bot(
    "bot_pico",
    "Pico",
    "Flaky tests",
    { color: "#fd971f", shape: "blob", expression: "focused", motion: "calm" },
    6,
  ),
  bot(
    "bot_sage",
    "Sage",
    "Vault digest",
    { color: "#ae81ff", shape: "cloud", expression: "curious", motion: "calm" },
    7,
  ),
  {
    ...bot(
      "bot_wren",
      "Wren",
      "Papers",
      { color: "#f92672", shape: "round", expression: "neutral", motion: "still" },
      8,
    ),
    sectionId: "sec_research",
  },
];

const summaries = new Map<string, BotSummary>([
  [
    "bot_pico",
    {
      attention: 0,
      working: true,
      finished: false,
      latest: { id: "t1", title: "Flaky test triage" },
    },
  ],
  [
    "bot_sage",
    {
      attention: 0,
      working: false,
      finished: true,
      latest: { id: "t3", title: "Weekly vault digest" },
    },
  ],
  [
    "bot_wren",
    {
      attention: 2,
      working: false,
      finished: false,
      latest: {
        id: "t2",
        title: "Paper notes on CRDTs and local-first sync",
      },
    },
  ],
]);

const actions: BotsActions = {
  createBot: fn(),
  editBot: fn(),
  openMainChat: fn(),
  newInProject: fn(),
  fork: fn(),
  setHidden: fn(),
  setPinned: fn(),
  setCompleted: fn(),
  move: fn(),
  hasWorkProjects: () => true,
};

/** The Bots tab without the inbox around it: pinned tiles, then shelves of rows. */
function BotsTab({ activeBotId }: { activeBotId: string | null }) {
  const onOpen = fn();
  return (
    <div>
      <PinnedBotGrid
        bots={bots.filter((entry) => entry.pinned === true)}
        threadsByBot={new Map()}
        activeBotId={activeBotId}
        onOpen={onOpen}
        actions={actions}
        canMove
      />
      {botShelves(bots, sections).map((shelf) => (
        <section key={shelf.key} aria-label={shelf.label}>
          <h2 className="flex items-center gap-2 pb-0.5 pr-2.5 pt-2 text-2xs font-medium text-muted-foreground/70">
            {shelf.label}
            <span className="h-px flex-1 bg-sidebar-border" />
          </h2>
          {shelf.bots.map((entry) => (
            <BotRow
              key={entry.id}
              bot={entry}
              summary={summaries.get(entry.id)}
              threads={[]}
              active={entry.id === activeBotId}
              onOpen={onOpen}
              actions={actions}
              canMoveUp={false}
              canMoveDown={false}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

const meta = {
  title: "Components/GTD Sidebar/Bots tab",
  component: BotsTab,
  tags: ["autodocs"],
  play: ready,
  decorators: [
    (Story) => (
      <div data-gtd-sidebar-thread-list="" style={{ width: 288, padding: 8 }}>
        <Story />
      </div>
    ),
  ],
  args: { activeBotId: "bot_ada" },
} satisfies Meta<typeof BotsTab>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A narrow panel keeps three tiles across and truncates names. */
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 200 }}>
        <Story />
      </div>
    ),
  ],
};
