import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test } from "vitest";
import { registerSessionMention } from "./session-mention.ts";

const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard" });
registerSessionMention(bb);
const [provider] = harness.registrations.mentionProviders;

test("an Add to chat pill tells the agent which session version to read", async () => {
  expect(provider?.search({ trigger: "@", query: "", projectId: null, threadId: null })).toEqual(
    [],
  );
  expect(await provider?.resolve("0b6c@4")).toEqual({
    context:
      'The user quoted Whiteboard session 0b6c, version 4. Read that version with whiteboard_session_get({"sessionId":"0b6c","version":4,"full":true}).',
  });
});

test("a pill this plugin did not insert blocks the send with a reason", async () => {
  await expect(async () => provider?.resolve("0b6c")).rejects.toThrow(
    "Unknown Whiteboard reference: 0b6c",
  );
});
