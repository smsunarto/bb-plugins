import { screenParameters } from "../../../.storybook/layout";
import { ready } from "../../../.storybook/ready";
import { within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AnnotationPanel } from "../components/annotation-panel";
import "../app.css";
const annotation = {
  id: "a_story",
  sessionId: "s_story",
  comment: "Keep the primary action reachable at narrow widths.",
  elementPath: "main > button",
  element: "button",
  timestamp: 1792670400000,
  x: 200,
  y: 150,
  status: "pending",
  kind: "feedback",
  thread: [],
  bb: {
    route: "/settings",
    pluginId: "agentation",
    surface: "navPanel",
    threadId: null,
    projectId: null,
    routeLabel: "Annotations",
  },
  createdAt: "2026-10-22T12:00:00Z",
  updatedAt: "2026-10-22T12:00:00Z",
  resolution: null,
  seq: 1,
};
const session = {
  id: "s_story",
  url: "http://localhost:6010",
  route: "/settings",
  title: "Annotations",
  status: "active",
  threadId: null,
  projectId: null,
  createdAt: annotation.createdAt,
  updatedAt: annotation.updatedAt,
};
const meta = {
  play: ready,
  title: "Screens/Agentation/Annotations",
  component: AnnotationPanel,
  parameters: {
    ...screenParameters,
    host: {
      pluginId: "agentation",
      rpc: {
        listAnnotations: () => ({ annotations: [annotation], routings: {} }),
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
