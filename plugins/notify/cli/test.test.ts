import { test as testCase } from "node:test";
import assert from "node:assert/strict";
import { invokeCLI } from "@bb-kit/core/cli";
import { stubClient } from "@bb-kit/core/testing";

import type { Client } from "../server.ts";
import { test } from "./test.ts";

testCase("test posts the sample notification from the invoking thread", async () => {
  const inputs: unknown[] = [];
  const client = stubClient<Client>({
    send: async (input) => {
      inputs.push(input);
      return { listening: true };
    },
  });
  const result = await invokeCLI({ test }, client, ["test"], {
    context: { threadId: "th-1", projectId: "p1" },
  });
  assert.deepEqual(result, { exitCode: 0, stdout: "Queued — a BB window is listening.\n" });
  assert.deepEqual(inputs, [
    {
      message: "Notifications are working. Click to open the thread this came from.",
      title: "bb notify",
      threadId: "th-1",
      projectId: "p1",
    },
  ]);
});

testCase("test prints the held line outside a thread", async () => {
  const inputs: unknown[] = [];
  const client = stubClient<Client>({
    send: async (input) => {
      inputs.push(input);
      return { listening: false };
    },
  });
  const result = await invokeCLI({ test }, client, ["test"]);
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "Held — no BB window is open. It will appear when one is.\n",
  });
  assert.deepEqual(inputs, [
    {
      message: "Notifications are working. Click to open the thread this came from.",
      title: "bb notify",
    },
  ]);
});
