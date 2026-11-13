import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { PrStatusRead } from "../core/pr-reads.ts";
import type { Exec, RunResult } from "../forge/github.ts";
import { runReviewRead } from "../forge/review.ts";
import { createForgeSites, type HostForge } from "./forge-sites.ts";
import { createPrReads } from "./pr-reads.ts";

type Pr = {
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft?: boolean;
  title?: string;
  checks?: { state: string; count: number }[];
};

/** GitHub as `gh api graphql` answers it: repositories each account can see, and their pull requests. */
type GitHub = Record<string, { visibleTo: string[]; prs: Record<number, Pr> }>;

const RAMPAGE: GitHub = {
  "argus-labs/rampage-client": {
    visibleTo: ["scott"],
    prs: {
      2419: { state: "MERGED", title: "Merge sweep: lobby" },
      2420: {
        state: "OPEN",
        checks: [
          { state: "SUCCESS", count: 5 },
          { state: "IN_PROGRESS", count: 1 },
        ],
      },
      2423: { state: "OPEN", isDraft: true },
      2425: { state: "MERGED" },
    },
  },
  "argus-labs/private-infra": { visibleTo: ["work"], prs: { 7: { state: "OPEN" } } },
};

function node(owner: string, name: string, number: number, pr: Pr) {
  return {
    number,
    url: `https://github.com/${owner}/${name}/pull/${number}`,
    title: pr.title ?? `PR ${number}`,
    state: pr.state,
    isDraft: pr.isDraft ?? false,
    updatedAt: "2026-11-10T12:00:00Z",
    headRefName: `feat/${number}`,
    baseRefName: "main",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    isInMergeQueue: false,
    autoMergeRequest: null,
    reviewRequests: { totalCount: 0 },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: { checkRunCountsByState: pr.checks ?? [], statusContextCountsByState: [] },
            },
          },
        },
      ],
    },
  };
}

/** `gh` signed in as `logins` (the first active), answering from `github`. */
function fakeGh(github: GitHub, logins: string[], calls: string[] = []): Exec {
  return async (args, options): Promise<RunResult> => {
    if (args[0] === "auth" && args[1] === "status")
      return {
        code: 0,
        stdout: logins
          .map(
            (login, i) =>
              `  ✓ Logged in to github.com account ${login} (keyring)\n  - Active account: ${i === 0}`,
          )
          .join("\n"),
        stderr: "",
      };
    if (args[0] === "auth" && args[1] === "token")
      return { code: 0, stdout: `tok-${args.at(-1)}`, stderr: "" };
    const login = options.env?.GH_TOKEN?.replace(/^tok-/, "") ?? logins[0]!;
    const { query, variables } = JSON.parse(options.stdin ?? "{}") as {
      query: string;
      variables: Record<string, string | number>;
    };
    const repoKey = `${variables.owner}/${variables.name}`.toLowerCase();
    calls.push(`${login}:${repoKey}`);
    const repo = github[repoKey];
    if (!repo || !repo.visibleTo.includes(login))
      return {
        code: 1,
        stdout: JSON.stringify({
          data: { repository: null },
          errors: [
            {
              type: "NOT_FOUND",
              path: ["repository"],
              message: `Could not resolve to a Repository with the name '${repoKey}'.`,
            },
          ],
        }),
        stderr: "gh: Could not resolve to a Repository",
      };
    const aliases = [...query.matchAll(/(p\d+): pullRequest\(number: \$(n\d+)\)/g)];
    const data: Record<string, unknown> = {};
    const errors: unknown[] = [];
    for (const [, alias, variable] of aliases) {
      const number = Number(variables[variable!]);
      const pr = repo.prs[number];
      data[alias!] = pr ? node(String(variables.owner), String(variables.name), number, pr) : null;
      if (!pr)
        errors.push({
          type: "NOT_FOUND",
          path: ["repository", alias],
          message: `Could not resolve to a PullRequest with the number of ${number}.`,
        });
    }
    // gh exits 1 whenever the answer carries errors, even beside data.
    return {
      code: errors.length ? 1 : 0,
      stdout: JSON.stringify({ data: { repository: data }, ...(errors.length ? { errors } : {}) }),
      stderr: errors.length ? "gh: Could not resolve to a PullRequest" : "",
    };
  };
}

const PLACEMENT = {
  hostId: "host-a",
  hostName: "studio-mac",
  path: "/w/rampage",
  environmentId: "env_1",
};

function setup(options: {
  server: string[];
  host?: string[];
  /** The host runs a build without the prStatuses read: its schema rejects it. */
  oldHost?: boolean;
  github?: GitHub;
}) {
  const github = options.github ?? RAMPAGE;
  const serverCalls: string[] = [];
  const hostCalls: string[] = [];
  const host: HostForge = {
    accounts: async () => ({ ok: true, value: { accounts: options.host ?? [] } }),
    review: async (_hostId, { read }) => {
      if (options.oldHost) throw new Error("Invalid input: unknown read kind prStatuses");
      return {
        ok: true,
        value: await runReviewRead(fakeGh(github, options.host ?? [], hostCalls), read),
      };
    },
    pullRequest: async () => {
      throw new Error("unused");
    },
    setDraft: async () => {
      throw new Error("unused");
    },
    merge: async () => {
      throw new Error("unused");
    },
    submitReview: async () => {
      throw new Error("unused");
    },
  };
  const sites = createForgeSites({
    serverExec: fakeGh(github, options.server, serverCalls),
    host,
    now: Date.now,
  });
  const environments: string[] = [];
  const read = createPrReads({
    sites,
    placements: {
      forEnvironment: (environmentId: string) => {
        environments.push(environmentId);
        return Effect.succeed({ state: "checkout" as const, placement: PLACEMENT });
      },
    } as never,
  });
  const run = (
    environmentId: string | null,
    refs: { owner: string; repo: string; number: number }[],
  ) => Effect.runPromise(read(environmentId, refs)) as Promise<Record<string, PrStatusRead>>;
  return { run, serverCalls, hostCalls, environments };
}

const ref = (repo: string, number: number) => {
  const [owner, name] = repo.split("/");
  return { owner: owner!, repo: name!, number };
};

describe("pullRequestsByRef", () => {
  it("reads a repository's pull requests in one call; a missing number fails only its own row", async () => {
    const { run, serverCalls } = setup({ server: ["scott"] });
    const answer = await run(null, [
      ref("Argus-Labs/rampage-client", 2419),
      ref("Argus-Labs/rampage-client", 2420),
      ref("Argus-Labs/rampage-client", 2423),
      ref("Argus-Labs/rampage-client", 9999),
    ]);
    expect(serverCalls).toEqual(["scott:argus-labs/rampage-client"]);
    expect(answer["Argus-Labs/rampage-client#2419"]).toMatchObject({
      ok: true,
      value: { number: 2419, state: "merged", title: "Merge sweep: lobby" },
    });
    expect(answer["Argus-Labs/rampage-client#2420"]).toMatchObject({
      ok: true,
      value: { state: "open", isDraft: false, checks: { passed: 5, failed: 0, pending: 1 } },
    });
    expect(answer["Argus-Labs/rampage-client#2423"]).toMatchObject({
      ok: true,
      value: { state: "open", isDraft: true },
    });
    expect(answer["Argus-Labs/rampage-client#9999"]).toMatchObject({
      ok: false,
      reason: "not-found",
    });
  });

  it("a repository no account can see fails its refs and leaves other repositories' rows", async () => {
    const { run } = setup({ server: ["scott"] });
    const answer = await run(null, [
      ref("Argus-Labs/rampage-client", 2425),
      ref("argus-labs/private-infra", 7),
    ]);
    expect(answer["Argus-Labs/rampage-client#2425"]).toMatchObject({
      ok: true,
      value: { state: "merged" },
    });
    expect(answer["argus-labs/private-infra#7"]).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });

  it("reads through the calling environment's host when the server's accounts can't see the repository", async () => {
    const { run, hostCalls, environments } = setup({ server: ["scott"], host: ["work"] });
    const answer = await run("env_1", [ref("argus-labs/private-infra", 7)]);
    expect(environments).toEqual(["env_1"]);
    expect(hostCalls).toEqual(["work:argus-labs/private-infra"]);
    expect(answer["argus-labs/private-infra#7"]).toMatchObject({
      ok: true,
      value: { number: 7, state: "open" },
    });
  });

  it("a host on an older build that rejects the read leaves that repository unavailable, not the call", async () => {
    const { run } = setup({ server: [], host: ["scott"], oldHost: true });
    const answer = await run("env_1", [ref("Argus-Labs/rampage-client", 2419)]);
    expect(answer["Argus-Labs/rampage-client#2419"]).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });
});
