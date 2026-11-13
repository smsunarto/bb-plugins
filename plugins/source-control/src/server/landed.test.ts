import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { handWrittenLanded, type Landed } from "../core/watch.ts";
import { createLanded } from "./landed.ts";
import { createPrWatcher } from "./pr-watch.ts";
import { openStore } from "./store.ts";

const PR = { owner: "acme", repo: "api", number: 42 };
const LINE = '::source-control-landed{prs="acme/api#42"}';

const landedAs = (state: "merged" | "open"): Landed => ({
  prs: [
    {
      ref: PR,
      url: "https://github.com/acme/api/pull/42",
      title: "Route gh",
      state,
    },
  ],
  commits: [],
});

/** A thread whose last turn closed with `reply`, and GitHub answering `state` for its pull request. */
function setup(reply: string | null, state: "merged" | "open" = "merged") {
  const titles: string[] = [];
  const reads: (string | null)[] = [];
  const { bb } = createFakePluginHost({
    pluginId: "source-control",
    sdk: {
      threads: {
        get: (async () => ({ id: "thr_a", title: titles.at(-1) ?? "Route gh" })) as never,
        update: (async ({ title }: { title: string }) => {
          titles.push(title);
        }) as never,
      },
    },
  });
  const store = openStore(bb);
  const watcher = createPrWatcher({
    bb,
    store,
    now: () => 2_000,
    standingDown: () => false,
    read: async () => ({ ok: false, reason: "away", message: "away" }),
  });
  let standingDown = false;
  const landed = createLanded({
    bb,
    store,
    watcher,
    now: () => 2_000,
    standingDown: () => standingDown,
    lastReply: async () => reply,
    read: async (login) => {
      reads.push(login);
      return { ok: true, login: "scott", value: landedAs(state) };
    },
  });
  return {
    landed,
    titles,
    reads,
    store,
    standDown: () => {
      standingDown = true;
    },
  };
}

test("a landed directive written by hand launches the title once GitHub says it merged", async () => {
  const world = setup(`Merged.\n\n${LINE}\n`);
  await world.landed.replied("thr_a");
  expect(world.titles).toEqual(["🚀 Route gh"]);
  // Read as the thread's host can, since the reply names no account.
  expect(world.reads).toEqual([null]);
  // The same reply at the next idle reads GitHub no more.
  await world.landed.replied("thr_a");
  expect(world.reads).toHaveLength(1);
});

test("a reply's claim alone launches nothing: GitHub must report the work landed", async () => {
  const world = setup(LINE, "open");
  await world.landed.replied("thr_a");
  expect(world.titles).toEqual([]);
  expect(world.store.landedThreads()).toEqual([]);
  // Not registered, so the next idle asks again.
  await world.landed.replied("thr_a");
  expect(world.reads).toHaveLength(2);
});

test("a directive in a code fence, in a sentence, or from the tool registers nothing", async () => {
  for (const reply of [
    `Write it like this:\n\n\`\`\`markdown\n${LINE}\n\`\`\`\n`,
    `Put ${LINE} on its own line.`,
    `    ${LINE}`,
    '::source-control-landed{prs="acme/api#42" account="scott"}',
    "Nothing landed.",
    null,
  ]) {
    const world = setup(reply);
    await world.landed.replied("thr_a");
    expect(world.reads, String(reply)).toEqual([]);
  }
  const standing = setup(LINE);
  standing.standDown();
  await standing.landed.replied("thr_a");
  expect(standing.reads).toEqual([]);
});

test("the hand-written list is the reply's last own-line directive", () => {
  expect(
    handWrittenLanded(`${LINE}\n\n~~~\n::source-control-landed{prs="acme/api#1"}\n~~~`),
  ).toEqual({ account: null, prs: [PR], commits: [] });
  expect(
    handWrittenLanded(
      '::source-control-landed{prs="acme/api#42 acme/web#7" commits="acme/api@c0ffee1"}',
    ),
  ).toEqual({
    account: null,
    prs: [PR, { owner: "acme", repo: "web", number: 7 }],
    commits: [{ owner: "acme", repo: "api", sha: "c0ffee1" }],
  });
  expect(handWrittenLanded('::source-control-landed{prs="the docs PR"}')).toBeNull();
  expect(handWrittenLanded("::source-control-landed{}")).toBeNull();
});
