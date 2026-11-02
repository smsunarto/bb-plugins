import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { CompletionSound } from "./completion-sound.tsx";
import { SendHaptic } from "./send-haptic.tsx";
import { TodoBanner } from "./rpiv-todo/banner.tsx";
import {
  THREAD_DETAILS_TITLE,
  ThreadDetailsHeaderAction,
} from "./thread-details/thread-details.tsx";
import "./rpiv-todo/style.css";
import "./timeline-motion/timeline-motion.css";
import { mountTimelineMotion } from "./timeline-motion/timeline-motion.ts";
import {
  PROBE_GROUP_TITLE,
  ThreadActivityProbe,
} from "./timeline-motion/thread-activity-probe.tsx";
import { JUMP_TO_LATEST_COMMAND, jumpToLatestEvent } from "./timeline-motion/jump-to-latest.ts";

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "completion-sound", component: CompletionSound });
  app.slots.experimental_threadHeaderAction({
    id: "thread-activity-probe",
    title: PROBE_GROUP_TITLE,
    component: ThreadActivityProbe,
  });
  app.slots.experimental_threadHeaderAction({
    id: "thread-details",
    title: THREAD_DETAILS_TITLE,
    component: ThreadDetailsHeaderAction,
  });
  app.contentScripts.register({
    id: "timeline-motion",
    mount: ({ signal }) => mountTimelineMotion(document, signal),
  });
  app.commands.register({
    ...JUMP_TO_LATEST_COMMAND,
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => {
      if (threadId !== null) jumpToLatestEvent(document, threadId);
    },
  });
  app.composer.customize({
    id: "rpiv-todo",
    // Side chats are ThreadChat composers and report the "thread" scope.
    scopes: ["thread", "queued-message"],
    banners: [{ id: "todos", chrome: "card", component: TodoBanner }],
  });
  app.composer.customize({
    id: "send-haptic",
    scopes: ["thread", "new-thread"],
    banners: [{ id: "send-haptic", chrome: "bare", component: SendHaptic }],
  });
});
