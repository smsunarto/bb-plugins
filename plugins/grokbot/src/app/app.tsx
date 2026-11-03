import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { GrokbotPage, GrokbotThreadTab } from "./panel.tsx";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "grokbot",
    title: "Grok Bot",
    icon: "grokbot/plugin",
    path: "grokbot",
    component: GrokbotPage,
  });
  // "Send this thread to Grok Bot": an action in the thread side panel.
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "send-thread",
    title: "Send to Grok Bot",
    icon: "grokbot/plugin",
    component: GrokbotThreadTab,
  });
});
