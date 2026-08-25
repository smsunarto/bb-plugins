import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeContext, queuedNotifications } from "../fake-context.ts";
import { send } from "./send.ts";

const USAGE = 'usage: bb notify send "<message>" [--title <text>] [--thread <id>]\n';

test("send posts the message and prints the queued line", async () => {
  const context = createFakeContext({
    projectName: (projectId) => Promise.resolve(projectId === "p1" ? "Acme" : null),
  });
  const result = await send.invoke(context, ["hello there", "--title", "T", "--thread", "th-1"], {
    cli: { threadId: "outer", projectId: "p1" },
  });
  assert.deepEqual(result, { exitCode: 0, stdout: "Queued — a BB window is listening.\n" });
  assert.deepEqual(await queuedNotifications(context), [
    { id: 1, title: "T", body: "[Acme] hello there", threadId: "th-1", silent: true },
  ]);
});

test("send falls back to the invoking thread and prints the held line", async () => {
  const context = createFakeContext({ listening: false });
  const result = await send.invoke(context, ["hi"], { cli: { threadId: "th-invoker" } });
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "Held — no BB window is open. It will appear when one is.\n",
  });
  assert.deepEqual(await queuedNotifications(context), [
    { id: 1, title: "bb", body: "hi", threadId: "th-invoker", silent: true },
  ]);
});

test("send rejects an invalid --thread before calling the handler", async () => {
  const context = createFakeContext();
  const result = await send.invoke(context, ["hi", "--thread", "bad id"]);
  assert.deepEqual(result, { exitCode: 2, stderr: "not a thread id: bad id\n" });
  assert.deepEqual(await queuedNotifications(context), []);
});

test("send without a message exits 2 with the usage line", async () => {
  const result = await send.invoke();
  assert.deepEqual(result, { exitCode: 2, stderr: USAGE });
});

test("send rejects a whitespace-only message with the usage line", async () => {
  const result = await send.invoke({}, ["   "]);
  assert.deepEqual(result, { exitCode: 2, stderr: USAGE });
});

test("send accepts --message as an alternative to the positional", async () => {
  const context = createFakeContext();
  const result = await send.invoke(context, ["--message", "hi"]);
  assert.deepEqual(result, { exitCode: 0, stdout: "Queued — a BB window is listening.\n" });
  assert.deepEqual(await queuedNotifications(context), [
    { id: 1, title: "bb", body: "hi", threadId: null, silent: true },
  ]);
});

test("send accepts --message=<text> and lets the positional win over it", async () => {
  const equals = createFakeContext();
  assert.equal((await send.invoke(equals, ["--message=hi"])).exitCode, 0);
  const both = createFakeContext();
  assert.equal((await send.invoke(both, ["positional", "--message", "flag"])).exitCode, 0);
  assert.deepEqual(await queuedNotifications(equals), [
    { id: 1, title: "bb", body: "hi", threadId: null, silent: true },
  ]);
  assert.deepEqual(await queuedNotifications(both), [
    { id: 1, title: "bb", body: "positional", threadId: null, silent: true },
  ]);
});

test("send joins unquoted multi-word messages like the old parser", async () => {
  const context = createFakeContext();
  const result = await send.invoke(context, ["build", "is", "done"]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(await queuedNotifications(context), [
    { id: 1, title: "bb", body: "build is done", threadId: null, silent: true },
  ]);
});

test("send trims the message before posting", async () => {
  const context = createFakeContext();
  const result = await send.invoke(context, ["  hi  "]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(await queuedNotifications(context), [
    { id: 1, title: "bb", body: "hi", threadId: null, silent: true },
  ]);
});
