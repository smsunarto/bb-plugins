import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeCLI } from "@bb-kit/core/cli";
import { stubClient } from "@bb-kit/core/testing";

import type { Client } from "../server.ts";
import { send } from "./send.ts";

test("send posts the message and prints the queued line", async () => {
  const inputs: unknown[] = [];
  const client = stubClient<Client>({
    send: async (input) => {
      inputs.push(input);
      return { listening: true };
    },
  });
  const result = await invokeCLI(
    { send },
    client,
    ["send", "hello there", "--title", "T", "--thread", "th-1"],
    { context: { threadId: "outer", projectId: "p1" } },
  );
  assert.deepEqual(result, { exitCode: 0, stdout: "Queued — a BB window is listening.\n" });
  assert.deepEqual(inputs, [
    { message: "hello there", title: "T", threadId: "th-1", projectId: "p1" },
  ]);
});

test("send falls back to the invoking thread and prints the held line", async () => {
  const inputs: unknown[] = [];
  const client = stubClient<Client>({
    send: async (input) => {
      inputs.push(input);
      return { listening: false };
    },
  });
  const result = await invokeCLI({ send }, client, ["send", "hi"], {
    context: { threadId: "th-invoker" },
  });
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "Held — no BB window is open. It will appear when one is.\n",
  });
  assert.deepEqual(inputs, [{ message: "hi", threadId: "th-invoker" }]);
});

test("send rejects an invalid --thread before calling the client", async () => {
  const result = await invokeCLI({ send }, stubClient<Client>({}), [
    "send",
    "hi",
    "--thread",
    "bad id",
  ]);
  assert.deepEqual(result, { exitCode: 2, stderr: "not a thread id: bad id\n" });
});

const USAGE = 'usage: bb notify send "<message>" [--title <text>] [--thread <id>]\n';

test("send without a message exits 2 with the usage line", async () => {
  const result = await invokeCLI({ send }, stubClient<Client>({}), ["send"]);
  assert.deepEqual(result, { exitCode: 2, stderr: USAGE });
});

test("send rejects a whitespace-only message with the usage line", async () => {
  const result = await invokeCLI({ send }, stubClient<Client>({}), ["send", "   "]);
  assert.deepEqual(result, { exitCode: 2, stderr: USAGE });
});

test("send accepts --message as an alternative to the positional", async () => {
  const inputs: unknown[] = [];
  const client = stubClient<Client>({
    send: async (input) => {
      inputs.push(input);
      return { listening: true };
    },
  });
  const result = await invokeCLI({ send }, client, ["send", "--message", "hi"]);
  assert.deepEqual(result, { exitCode: 0, stdout: "Queued — a BB window is listening.\n" });
  assert.deepEqual(inputs, [{ message: "hi" }]);
});

test("send accepts --message=<text> and lets the positional win over it", async () => {
  const inputs: unknown[] = [];
  const client = stubClient<Client>({
    send: async (input) => {
      inputs.push(input);
      return { listening: true };
    },
  });
  const equals = await invokeCLI({ send }, client, ["send", "--message=hi"]);
  assert.equal(equals.exitCode, 0);
  const both = await invokeCLI({ send }, client, ["send", "positional", "--message", "flag"]);
  assert.equal(both.exitCode, 0);
  assert.deepEqual(inputs, [{ message: "hi" }, { message: "positional" }]);
});

test("send joins unquoted multi-word messages like the old parser", async () => {
  const inputs: unknown[] = [];
  const client = stubClient<Client>({
    send: async (input) => {
      inputs.push(input);
      return { listening: true };
    },
  });
  const result = await invokeCLI({ send }, client, ["send", "build", "is", "done"]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(inputs, [{ message: "build is done" }]);
});

test("send trims the message before posting", async () => {
  const inputs: unknown[] = [];
  const client = stubClient<Client>({
    send: async (input) => {
      inputs.push(input);
      return { listening: true };
    },
  });
  const result = await invokeCLI({ send }, client, ["send", "  hi  "]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(inputs, [{ message: "hi" }]);
});
