import { defineCommand } from "@bb-kit/core/cli";

import type { Client } from "../server.ts";

/** Post a fixed sample notification so the user can check the whole path. */
export const test = defineCommand({
  summary: "Post a sample notification to verify the setup",
  run: async (client: Client, { context }) => {
    const input: Parameters<Client["send"]>[0] = {
      message: "Notifications are working. Click to open the thread this came from.",
      title: "bb notify",
    };
    if (context.threadId !== undefined) input.threadId = context.threadId;
    if (context.projectId !== undefined) input.projectId = context.projectId;
    const { listening } = await client.send(input);
    return listening
      ? { exitCode: 0, stdout: "Queued — a BB window is listening.\n" }
      : { exitCode: 0, stdout: "Held — no BB window is open. It will appear when one is.\n" };
  },
});
