import { screenParameters } from "../../../.storybook/layout";
import { ready } from "../../../.storybook/ready";
import { within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { storedAnnotationSchema, sessionSummarySchema } from "../lib/afs";
import { AnnotationPanel } from "../components/annotation-panel";
import "../app.css";
const annotation = {
  id: "a_story",
  sessionId: "s_story",
  comment:
    "The Retry action disappears below the fold at 360px. Keep it next to the offline message so I can reconnect without scrolling.",
  elementPath: "main > section[data-review] > .offline-notice > button",
  element: "button",
  timestamp: 1792670400000,
  x: 200,
  y: 150,
  status: "pending",
  kind: "feedback",
  thread: [],
  bb: {
    route: "/reviews/atlas-offline-recovery",
    pluginId: "code-review",
    surface: "navPanel",
    threadId: null,
    projectId: null,
    routeLabel: "Atlas review · offline recovery",
  },
  createdAt: "2026-10-22T12:00:00Z",
  updatedAt: "2026-10-22T12:00:00Z",
  resolution: null,
  seq: 1,
};
const session = {
  id: "s_story",
  url: "http://localhost:6010",
  route: "/reviews/atlas-offline-recovery",
  title: "Atlas review · offline recovery",
  status: "active",
  threadId: null,
  projectId: null,
  createdAt: annotation.createdAt,
  updatedAt: annotation.updatedAt,
  counts: { total: 3, pending: 1, acknowledged: 1, resolved: 1, dismissed: 0 },
  lastAnnotationAt: annotation.updatedAt,
};
const annotations = [
  annotation,
  {
    ...annotation,
    id: "a_keyboard",
    status: "acknowledged",
    seq: 2,
    comment:
      "After closing the file picker, return keyboard focus to the file that opened it. Right now Tab starts at the top of the page.",
    element: "dialog",
    elementPath: "main > [role=dialog]",
    thread: [
      {
        id: "reply_keyboard",
        timestamp: 1792744800000,
        role: "agent",
        content:
          "Confirmed. I am tracing the dialog close handler and will restore focus to the trigger.",
      },
    ],
  },
  {
    ...annotation,
    id: "a_cache_label",
    status: "resolved",
    seq: 3,
    comment:
      "Show when the cached snapshot was last refreshed; the current label reads as though it is live.",
    element: "span",
    elementPath: ".review-sync-state",
    resolution: "Added a cached timestamp and verified it while the checkout host is offline.",
    thread: [],
  },
];
annotations.forEach((item) => storedAnnotationSchema.parse(item));
sessionSummarySchema.parse(session);
const meta = {
  play: ready,
  title: "Screens/Agentation/Annotations",
  component: AnnotationPanel,
  parameters: {
    ...screenParameters,
    host: {
      pluginId: "agentation",
      rpc: {
        listAnnotations: (input: { statuses: string[] | null }) => ({
          annotations: annotations.filter(
            (item) => !input.statuses || input.statuses.includes(item.status),
          ),
          routings: {},
        }),
        listSessions: () => ({ sessions: [session] }),
      },
    },
  },
} satisfies Meta<typeof AnnotationPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Pending: Story = {
  play: async (context) => {
    await ready(context);
    await within(context.canvasElement).findByText(annotation.comment);
  },
};
export const Empty: Story = {
  play: async (context) => {
    await ready(context);
    await within(context.canvasElement).findByText("No annotations here yet.");
  },
  parameters: {
    host: {
      pluginId: "agentation",
      rpc: {
        listAnnotations: () => ({ annotations: [], routings: {} }),
        listSessions: () => ({ sessions: [] }),
      },
    },
  },
};
export const Loading: Story = {
  play: async (context) => {
    await ready(context);
    await within(context.canvasElement).findByText("Loading annotations…");
  },
  parameters: {
    host: {
      pluginId: "agentation",
      rpc: {
        listAnnotations: () => new Promise(() => {}),
        listSessions: () => new Promise(() => {}),
      },
    },
  },
};
export const Error: Story = {
  play: async (context) => {
    await ready(context);
    await within(context.canvasElement).findByText("Annotations are unavailable");
  },
  parameters: {
    host: {
      pluginId: "agentation",
      rpc: {
        listAnnotations: () => Promise.reject(new globalThis.Error("Annotations are unavailable")),
        listSessions: () => ({ sessions: [] }),
      },
    },
  },
};
