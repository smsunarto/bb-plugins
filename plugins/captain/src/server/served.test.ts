import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { describe, expect, test } from "vitest";
import { unifiedDiff } from "./diff.ts";
import { fingerprint } from "./served.ts";
import { captainHost, newCaptain, type CaptainHost } from "./test-host.ts";

type Overrides = Parameters<typeof makePluginAgentConfigurationContext>[0];

const LEAD = "[captain] Captain changed your instructions after this session started";

async function setup() {
  const host = await captainHost();
  const captainId = await newCaptain(host);
  host.addTask("BBPLUGINS-1", { title: "Render PR images" });
  const captain: Overrides = {
    thread: { id: captainId },
    pluginMetadata: { captain: { name: "Plugins" } },
  };
  /** bb builds a session, or submits a turn: either way `configure` runs. */
  const configure = (overrides: Overrides) =>
    host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext(overrides));
  async function crew(): Promise<{ id: string; context: Overrides }> {
    const result = await host.harness.behavior.runCli(
      ["dispatch", "BBPLUGINS-1", "--role", "Implement", "--json"],
      { threadId: captainId },
    );
    if (result.exitCode !== 0) throw new Error(`dispatch failed: ${result.stdout}`);
    const id = (JSON.parse(result.stdout) as { results: { thread: string }[] }).results[0]?.thread;
    if (id === undefined) throw new Error("dispatch printed no thread");
    host.updateThread(id, { status: "idle" });
    return {
      id,
      context: { thread: { id, parentThreadId: captainId }, project: { id: "proj_plugins" } },
    };
  }
  /** Run one pass and return what it sent to these threads. */
  async function pass(...threadIds: string[]) {
    const before = host.sent.length;
    await host.server.check.pass();
    return host.sent.slice(before).filter((m) => threadIds.includes(m.threadId));
  }
  return { host, captainId, captain, configure, crew, pass };
}

/**
 * Pretend the thread's session was built from older files: the served record
 * holds `edit(today's text)`, as if the files changed after it was served.
 */
function servedEarlier(host: CaptainHost, threadId: string, edit: (text: string) => string) {
  const [row] = host.server.store.servedOf([threadId]);
  if (row === undefined) throw new Error(`nothing served to ${threadId}`);
  const text = edit(row.text);
  expect(text).not.toBe(row.text);
  host.server.store.swapServed(threadId, row.fingerprint, {
    text,
    fingerprint: fingerprint(text),
    servedAt: row.servedAt,
  });
}

/** Drop the first line that contains `needle`, and return it. */
function dropLine(needle: string): [(text: string) => string, () => string] {
  let dropped = "";
  return [
    (text) => {
      const lines = text.split("\n");
      const index = lines.findIndex((line) => line.includes(needle));
      dropped = lines[index] ?? "";
      lines.splice(index, 1);
      return lines.join("\n");
    },
    () => dropped,
  ];
}

describe("instruction change notices", () => {
  test("a live Captain served older captain.md gets one message with the diff, then none", async () => {
    const { host, captainId, captain, configure, pass } = await setup();
    await configure(captain);
    const [edit, dropped] = dropLine("Captain");
    servedEarlier(host, captainId, edit);

    const first = await pass(captainId);
    const second = await pass(captainId);

    expect(first).toHaveLength(1);
    expect(first[0]?.mode).toBe("queue-if-active");
    expect(first[0]?.text).toContain(LEAD);
    expect(first[0]?.text).toContain("````diff\n@@ ");
    expect(first[0]?.text).toContain(`\n+${dropped()}\n`);
    expect(second).toEqual([]);
  });

  test("a live crew thread served an older role contract gets one message with the diff, then none", async () => {
    const { host, captainId, configure, crew, pass } = await setup();
    const thread = await crew();
    await configure(thread.context);
    expect(host.server.store.servedOf([thread.id])[0]?.text).toContain("# Role: Implement");
    const [edit, dropped] = dropLine("Role: Implement");
    servedEarlier(host, thread.id, edit);

    const first = await pass(thread.id, captainId);
    const second = await pass(thread.id, captainId);

    expect(first).toHaveLength(1);
    expect(first[0]?.threadId).toBe(thread.id);
    expect(first[0]?.text).toContain(`\n+${dropped()}\n`);
    expect(second).toEqual([]);
  });

  test("a crew thread served an older crew.md is told too", async () => {
    const { host, captainId, configure, crew, pass } = await setup();
    const thread = await crew();
    await configure(thread.context);
    const [edit, dropped] = dropLine("You are crew");
    servedEarlier(host, thread.id, edit);

    const sent = await pass(thread.id, captainId);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain(`+${dropped()}`);
  });

  test("a new thread's first configure and unchanged files send nothing", async () => {
    const { captainId, captain, configure, crew, pass } = await setup();
    await configure(captain);
    const thread = await crew();
    await configure(thread.context);

    expect(await pass(captainId, thread.id)).toEqual([]);
    expect(await pass(captainId, thread.id)).toEqual([]);
  });

  test("a later turn's configure keeps the first served text, so the change is still told", async () => {
    const { host, captainId, captain, configure, pass } = await setup();
    await configure(captain);
    const [edit, dropped] = dropLine("Captain");
    servedEarlier(host, captainId, edit);
    // The next turn re-runs configure against today's files; the session still holds the old text.
    await configure(captain);

    const sent = await pass(captainId);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain(`+${dropped()}`);
  });

  test("a failed send is retried on the next pass, and sent once", async () => {
    const { host, captainId, captain, configure, pass } = await setup();
    await configure(captain);
    servedEarlier(host, captainId, dropLine("Captain")[0]);
    host.sendFails.add(captainId);

    const failed = await pass(captainId);
    host.sendFails.delete(captainId);
    const retried = await pass(captainId);
    const after = await pass(captainId);

    expect(failed).toEqual([]);
    expect(retried).toHaveLength(1);
    expect(after).toEqual([]);
  });

  test("an archived crew thread is skipped", async () => {
    const { host, captainId, configure, crew, pass } = await setup();
    const thread = await crew();
    await configure(thread.context);
    servedEarlier(host, thread.id, dropLine("Role: Implement")[0]);
    host.updateThread(thread.id, { archivedAt: 5_000 });

    expect(await pass(thread.id, captainId)).toEqual([]);
  });

  test("a rewrite larger than its diff sends the full new text instead", async () => {
    const { host, captainId, captain, configure, pass } = await setup();
    await configure(captain);
    servedEarlier(host, captainId, () => "An entirely different text.");

    const [sent] = await pass(captainId);

    expect(sent?.text).toContain("full new text");
    expect(sent?.text).not.toContain("````diff");
    expect(sent?.text).toContain('You are the "Plugins" Captain');
  });
});

describe("unifiedDiff", () => {
  test("no change is an empty diff", () => {
    expect(unifiedDiff("a\nb", "a\nb")).toBe("");
  });

  test("a changed line shows as a removal then an addition, with context", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n");
    const after = ["1", "2", "3", "4", "five", "6", "7", "8", "9"].join("\n");
    expect(unifiedDiff(before, after, 2)).toBe(
      ["@@ -3,5 +3,5 @@", " 3", " 4", "-5", "+five", " 6", " 7"].join("\n"),
    );
  });

  test("distant changes get separate hunks", () => {
    const lines = Array.from({ length: 20 }, (_, i) => String(i));
    const after = [...lines];
    after[1] = "one";
    after[18] = "eighteen";
    const diff = unifiedDiff(lines.join("\n"), after.join("\n"), 1);
    expect(diff.match(/^@@/gmu)).toHaveLength(2);
    expect(diff).toContain("@@ -1,3 +1,3 @@");
    expect(diff).toContain("@@ -18,3 +18,3 @@");
  });
});
