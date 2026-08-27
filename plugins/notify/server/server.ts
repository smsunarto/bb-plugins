import { definePlugin } from "@bb-kit/core/plugin";

import { send as sendCommand } from "./command/send.ts";
import { status as statusCommand } from "./command/status.ts";
import { test as testCommand } from "./command/test.ts";
import { send } from "./rpc/send.ts";
import { status } from "./rpc/status.ts";
import { user } from "./tools/user.ts";
import { notificationQueue } from "./delivery.ts";
import { registerEvents } from "./events.ts";
import { playSound } from "./sound.ts";
import { projectNames } from "./project-names.ts";
import { registerRoutes } from "./routes.ts";
import { runTracker } from "./run-tracker.ts";
import { bindSettings, SETTINGS_BLOCK } from "./settings.ts";

export default definePlugin({
  pluginId: "notify",
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
    const queueSound = (name: string) => {
      soundPlayback = soundPlayback.then(() => playSound(name));
    };

    registerRoutes(bb, queueSound);
    registerEvents(bb);

    bb.onDispose(async () => {
      notificationQueue(bb).release();
      runTracker(bb).clear();
      projectNames(bb).clear();
      await soundPlayback;
    });
  },
});
