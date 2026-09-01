import { definePlugin } from "@bb-kit/core/plugin";
import { sentryPluginTelemetry } from "@bb-kit/sentry/telemetry";

import { send as sendCommand } from "./command/send.ts";
import { status as statusCommand } from "./command/status.ts";
import { test as testCommand } from "./command/test.ts";
import { send } from "./rpc/send.ts";
import { status } from "./rpc/status.ts";
import { user } from "./tools/user.ts";
import { registerEvents } from "./events.ts";
import { projectNames } from "./project-names.ts";
import { registerRendererMailboxRoutes, rendererMailbox } from "./renderer-mailbox.ts";
import { runTracker } from "./run-tracker.ts";
import { bindSettings, SETTINGS_BLOCK } from "./settings.ts";
import { playSound } from "./sound.ts";

const telemetry = sentryPluginTelemetry({
  pluginId: "notify",
  serverEntryUrl: import.meta.url,
  dsn: "https://56f8b9fe016877d46b7d379c17a1e6ea@o4506475620204544.ingest.us.sentry.io/4511947654758400",
});

export default definePlugin({
  pluginId: "notify",
  errorReporter: telemetry.errorReporter,
  performanceReporter: telemetry.performanceReporter,
  rpc: { send, status },
  command: { send: sendCommand, status: statusCommand, test: testCommand },
  agents: { tools: { user } },
  async setup(bb) {
    const settings = bb.settings.define(SETTINGS_BLOCK);
    let current = await settings.get();
    bindSettings(bb, () => current);
    settings.onChange((next) => {
      current = next;
      bb.log.info("settings changed");
    });

    let soundPlayback = Promise.resolve();
    registerRendererMailboxRoutes(bb, {
      queueSound(name) {
        soundPlayback = soundPlayback.then(() => playSound(name));
      },
    });
    registerEvents(bb);

    bb.onDispose(async () => {
      rendererMailbox(bb).dispose();
      runTracker(bb).clear();
      projectNames(bb).clear();
      await soundPlayback;
    });
  },
});
