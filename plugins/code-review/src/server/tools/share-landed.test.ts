import { expect, test } from "bun:test";
import {
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { GraphqlFailure, fakeContext } from "../../../test/fake-gh.ts";
import { recheckLanded } from "../lib/landed.ts";
import { shareLanded, shareLandedEnabled } from "./share-landed.ts";
import { watchPr } from "./watch-pr.ts";

const tool = { threadId: "thr_a", projectId: "p-api", signal: new AbortController().signal };
const SHA = "b".repeat(40);
const commit = (sha: string, message: string) => ({
  sha,
  html_url: `https://github.com/acme/api/commit/${sha}`,
  commit: { message },
});

/** A GitHub with pull requests #7 and #9 and a commit, and a thread whose title the tool can set. */
function setup(title: string | null = "Rate limit the API") {
  const github = {
    states: { 7: "MERGED", 9: "OPEN" } as Record<number, string>,
    onMain: true,
    /** Holds pull request reads until it settles. */
    hold: null as Promise<void> | null,
  };
  const thread = { title, archivedAt: null as number | null, refuseUpdates: 0 };
  const titles: string[] = [];
  const fake = fakeContext(
    {
      graphql: {
        LandedPr: async ({ number }) => {
          if (github.hold) await github.hold;
          if (github.states[number as number] === undefined) {
            throw new GraphqlFailure(
              "NOT_FOUND",
              `Could not resolve to a PullRequest with the number of ${String(number)}.`,
            );
          }
          return {
            repository: {
              pullRequest: {
                url: `https://github.com/acme/api/pull/${String(number)}`,
                title: `Pull request ${String(number)}`,
                state: github.states[number as number],
              },
            },
          };
        },
        PrWatch: ({ number }) => ({
          rateLimit: { remaining: 5000, resetAt: "2026-10-28T14:00:00.000Z" },
          viewer: { login: "octocat" },
          repository: {
            pullRequest: {
              url: `https://github.com/acme/api/pull/${String(number)}`,
              title: `Pull request ${String(number)}`,
              state: github.states[number as number],
              baseRefName: "main",
              mergeStateStatus: "CLEAN",
              comments: { nodes: [] },
              reviews: { nodes: [] },
              reviewThreads: { nodes: [] },
            },
          },
        }),
        Checks: () => ({
          repository: {
            pullRequest: {
              headRefOid: "a".repeat(40),
              commits: { nodes: [{ commit: { id: "C_a", statusCheckRollup: null } }] },
            },
          },
        }),
      },
      rest: {
        "repos/acme/api": { default_branch: "main" },
        "repos/acme/api/compare/main...bbbbbbb": () =>
          github.onMain
            ? { ahead_by: 0, merge_base_commit: commit(SHA, "Ship it\n\nBody"), commits: [] }
            : {
                ahead_by: 1,
                merge_base_commit: commit("c".repeat(40), "Base"),
                commits: [commit(SHA, "Ship it")],
              },
      },
    },
    {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            title: thread.title,
            titleFallback: "fix the api...",
            archivedAt: thread.archivedAt,
          }),
        update: async (input) => {
          if (thread.refuseUpdates > 0) {
            thread.refuseUpdates -= 1;
            throw new Error("bb is restarting");
          }
          if ("title" in input && typeof input.title === "string") {
            thread.title = input.title;
            titles.push(input.title);
          }
          return makeThreadResponse({ id: input.threadId, title: thread.title });
        },
      },
    },
  );
  const call = (input: Parameters<ReturnType<typeof shareLanded>["execute"]>[0]) =>
    shareLanded(fake.ctx).execute(input, tool);
  return { ...fake, github, thread, titles, call };
}

test("authors get the tool; answering reviewers never merge", () => {
  const enabled = (overrides: Parameters<typeof makePluginAgentConfigurationContext>[0]) =>
    shareLandedEnabled(makePluginAgentConfigurationContext(overrides));
  expect(enabled({})).toBe(true);
  expect(enabled({ pluginMetadata: { kind: "review", pr: "acme/api#7" } })).toBe(false);
});

test("a merged pull request and a pushed commit return the card and launch the title once", async () => {
  const { call, thread, titles } = setup();
  const result = await call({
    pullRequests: ["https://github.com/acme/api/pull/7/files"],
    commits: ["https://github.com/acme/api/commit/bbbbbbb"],
  });
  const [directive, note] = result.split("\n\n");
  expect(directive).toBe(
    `::code-review-landed{prs="acme/api#7" commits="acme/api@${SHA}" account="octocat"}`,
  );
  expect(note).toBe("Everything listed has landed; the thread title starts with 🚀.");
  expect(thread.title).toBe("🚀 Rate limit the API");
  await call({ pullRequests: ["acme/api#7"], commits: ["acme/api@bbbbbbb"] });
  expect(titles).toEqual(["🚀 Rate limit the API"]);
});

test("an unnamed thread launches with its fallback title", async () => {
  const { call, thread } = setup(null);
  await call({ pullRequests: ["acme/api#7"] });
  expect(thread.title).toBe("🚀 fix the api...");
});

test("work still open names what remains and takes an earlier 🚀 off", async () => {
  const { call, github, thread } = setup("🚀 Rate limit the API");
  github.onMain = false;
  const result = await call({
    pullRequests: ["acme/api#7", "acme/api#9"],
    commits: ["acme/api@bbbbbbb"],
  });
  expect(result).toStartWith(
    `::code-review-landed{prs="acme/api#7 acme/api#9" commits="acme/api@${SHA}" account="octocat"}`,
  );
  expect(result).toEndWith(
    `Not landed yet: acme/api#9 (open), acme/api@${SHA} (not on main). The title gets 🚀 once all of it lands.`,
  );
  expect(thread.title).toBe("Rate limit the API");
});

test("a merged pull request's watch stops, and a watch of an unlisted one must be listed", async () => {
  const { call, ctx, github, thread, titles } = setup();
  github.states[7] = "OPEN";
  await ctx.watcher.watch(tool.threadId, { owner: "acme", repo: "api", number: 7 });
  await ctx.watcher.watch(tool.threadId, { owner: "acme", repo: "api", number: 9 });
  github.states[7] = "MERGED";
  await expect(call({ pullRequests: ["acme/api#7"] })).rejects.toThrow(
    "This thread watches acme/api#9. List it too, or stop its watch",
  );
  expect(titles).toEqual([]);
  expect(await call({ pullRequests: ["acme/api#7", "acme/api#9"] })).toEndWith(
    "Not landed yet: acme/api#9 (open). The title gets 🚀 once all of it lands.",
  );
  expect((await ctx.watcher.list(tool.threadId)).map((watch) => watch.ref.number)).toEqual([9]);
  expect(thread.title).toBe("Rate limit the API");
});
test("nothing landed, and references that are not GitHub's, are refused", async () => {
  const { call, github, titles } = setup();
  github.onMain = false;
  await expect(
    call({ pullRequests: ["acme/api#9"], commits: ["acme/api@bbbbbbb"] }),
  ).rejects.toThrow("Nothing listed has landed yet: acme/api#9 (open)");
  await expect(call({})).rejects.toThrow("List the pull requests");
  await expect(call({ pullRequests: ["javascript:alert(1)"] })).rejects.toThrow(
    "GitHub pull request URL",
  );
  await expect(call({ commits: ["acme/api@main"] })).rejects.toThrow("owner/repo@<sha>");
  await expect(call({ commits: ["acme/api@ddddddd"] })).rejects.toThrow("acme/api@ddddddd:");
  expect(titles).toEqual([]);
});

test("watching a pull request takes the 🚀 off: the thread has work open again", async () => {
  const { ctx, thread } = setup("🚀 Rate limit the API");
  await watchPr(ctx).execute({ reference: "acme/api#9" }, tool);
  expect(thread.title).toBe("Rate limit the API");
});

test("the same pull request or commit listed twice shows once", async () => {
  const { call } = setup();
  const result = await call({
    pullRequests: ["acme/api#7", "https://github.com/acme/api/pull/7"],
    commits: ["acme/api@bbbbbbb", `acme/api@${SHA}`],
  });
  expect(result).toStartWith(
    `::code-review-landed{prs="acme/api#7" commits="acme/api@${SHA}" account="octocat"}`,
  );
});

test("work that lands after the turn launches the title from the server, then stops being checked", async () => {
  const { call, ctx, github, thread, operations } = setup();
  await call({ pullRequests: ["acme/api#7", "acme/api#9"] });
  expect(thread.title).toBe("Rate limit the API");
  await recheckLanded(ctx);
  expect(thread.title).toBe("Rate limit the API");

  github.states[9] = "MERGED";
  await recheckLanded(ctx);
  expect(thread.title).toBe("🚀 Rate limit the API");
  const reads = operations().length;
  await recheckLanded(ctx);
  expect(operations().length).toBe(reads);
});

test("a pull request closed without merging, or an archived thread, is not checked again", async () => {
  const closed = setup();
  closed.github.states[9] = "CLOSED";
  expect(await closed.call({ pullRequests: ["acme/api#7", "acme/api#9"] })).toContain(
    "acme/api#9 (closed without merging)",
  );
  const reads = closed.operations().length;
  await recheckLanded(closed.ctx);
  expect(closed.operations().length).toBe(reads);

  const archived = setup();
  await archived.call({ pullRequests: ["acme/api#7", "acme/api#9"] });
  archived.thread.archivedAt = Date.parse("2026-10-28T00:00:00.000Z");
  archived.github.states[9] = "MERGED";
  await recheckLanded(archived.ctx);
  archived.thread.archivedAt = null;
  await recheckLanded(archived.ctx);
  expect(archived.thread.title).toBe("Rate limit the API");
});

test("a launch bb refused is retried by the next check", async () => {
  const { call, ctx, thread } = setup();
  thread.refuseUpdates = 1;
  expect(await call({ pullRequests: ["acme/api#7"] })).toEndWith(
    "Everything listed has landed, but the thread title could not be updated.",
  );
  expect(thread.title).toBe("Rate limit the API");
  await recheckLanded(ctx);
  expect(thread.title).toBe("🚀 Rate limit the API");
});

test("a check that started on an older list never replaces the newer one", async () => {
  const { call, ctx, github, thread } = setup();
  await call({ pullRequests: ["acme/api#7", "acme/api#9"] });
  github.states[9] = "MERGED";
  github.states[11] = "OPEN";
  // The agent lists #11 while the background pass is waiting on bb.
  const recheck = recheckLanded(ctx);
  await call({ pullRequests: ["acme/api#7", "acme/api#9", "acme/api#11"] });
  await recheck;
  await recheckLanded(ctx);
  expect(thread.title).toBe("Rate limit the API");
  github.states[11] = "MERGED";
  await recheckLanded(ctx);
  expect(thread.title).toBe("🚀 Rate limit the API");
});

test("work GitHub can no longer find stops being checked", async () => {
  const { call, ctx, github, operations } = setup();
  await call({ pullRequests: ["acme/api#7", "acme/api#9"] });
  delete github.states[9];
  await recheckLanded(ctx);
  const reads = operations().length;
  await recheckLanded(ctx);
  expect(operations().length).toBe(reads);
});

test("starting a watch takes the 🚀 off and ends the check of the earlier list", async () => {
  const { call, ctx, github, thread, operations } = setup();
  await call({ pullRequests: ["acme/api#7", "acme/api#9"] });
  github.states[11] = "OPEN";
  await watchPr(ctx).execute({ reference: "acme/api#11" }, tool);
  github.states[9] = "MERGED";
  const reads = operations().length;
  await recheckLanded(ctx);
  expect(operations().length).toBe(reads);
  expect(thread.title).toBe("Rate limit the API");
});

test("a watch started while GitHub answers still has to be listed", async () => {
  const { call, ctx, github, thread } = setup();
  let release = () => {};
  github.hold = new Promise((resolve) => {
    release = resolve;
  });
  const landing = call({ pullRequests: ["acme/api#7"] });
  github.states[11] = "OPEN";
  await watchPr(ctx).execute({ reference: "acme/api#11" }, tool);
  github.hold = null;
  release();
  await expect(landing).rejects.toThrow("This thread watches acme/api#11.");
  expect(thread.title).toBe("Rate limit the API");
});

test("watching a listed pull request keeps it checked after the watch stops", async () => {
  const { call, ctx, github, thread } = setup();
  await call({ pullRequests: ["acme/api#7", "acme/api#9"] });
  await watchPr(ctx).execute({ reference: "acme/api#9" }, tool);
  await watchPr(ctx).execute({ reference: "acme/api#9", stop: true }, tool);
  github.states[9] = "MERGED";
  await recheckLanded(ctx);
  expect(thread.title).toBe("🚀 Rate limit the API");
});
