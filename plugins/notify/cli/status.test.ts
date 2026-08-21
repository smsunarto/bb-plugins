import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeCLI } from "@bb-kit/core/cli";
import { stubClient } from "@bb-kit/core/testing";

import type { Client } from "../server.ts";
import { status } from "./status.ts";

test("status prints every line, aligned, for a listening window", async () => {
  const client = stubClient<Client>({
    status: async () => ({
      listening: true,
      polling: 2,
      held: 3,
      notifyOnIdle: true,
      notifyOnFailed: false,
      includeChildThreads: false,
      includeHiddenThreads: true,
      minRunSeconds: 5,
      sound: "Glass",
      agentTool: true,
    }),
  });
  const result = await invokeCLI({ status }, client, ["status"]);
  assert.deepEqual(result, {
    exitCode: 0,
    stdout:
      "window:     listening (2 polling)\n" +
      "held:       3\n" +
      "on idle:    true\n" +
      "on failed:  false\n" +
      "children:   false\n" +
      "hidden:     true\n" +
      "min run:    5s\n" +
      "sound:      Glass\n" +
      "agent tool: notify_user\n",
  });
});

test("status prints the closed-window and disabled-tool wording", async () => {
  const client = stubClient<Client>({
    status: async () => ({
      listening: false,
      polling: 0,
      held: 0,
      notifyOnIdle: true,
      notifyOnFailed: true,
      includeChildThreads: false,
      includeHiddenThreads: false,
      minRunSeconds: 0,
      sound: "off",
      agentTool: false,
    }),
  });
  const result = await invokeCLI({ status }, client, ["status"]);
  assert.deepEqual(result, {
    exitCode: 0,
    stdout:
      "window:     none open — notifications will wait\n" +
      "held:       0\n" +
      "on idle:    true\n" +
      "on failed:  true\n" +
      "children:   false\n" +
      "hidden:     false\n" +
      "min run:    0s\n" +
      "sound:      off\n" +
      "agent tool: disabled\n",
  });
});
