import { expect, test } from "vitest";
import { readPullRequest, type Exec } from "./github.ts";

const repo = { owner: "acme", name: "api" };
const node = (number: number, state: "OPEN" | "MERGED", headRefName = "feature") => ({
  number,
  url: `https://github.com/acme/api/pull/${number}`,
  title: "Route gh",
  state,
  isDraft: false,
  headRefName,
  headRefOid: "c0ffee",
  baseRefName: "main",
  reviewDecision: null,
  headRepositoryOwner: { login: "scott" },
});

/** GitHub holding `prs` on branch "feature", recording which query each call ran. */
function github(prs: ReturnType<typeof node>[]) {
  const calls: string[] = [];
  const exec: Exec = async (_args, { stdin }) => {
    const { query, variables } = JSON.parse(String(stdin)) as {
      query: string;
      variables: { number?: number };
    };
    const one = query.includes("pullRequest(number:");
    calls.push(one ? `#${variables.number}` : "list");
    const data = one
      ? { repository: { pullRequest: prs.find((pr) => pr.number === variables.number) ?? null } }
      : { repository: { pullRequests: { nodes: prs } } };
    return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
  };
  return { exec, calls };
}

test("a branch's pull request is chosen from a cheap list, then read alone", async () => {
  const gh = github([node(7, "MERGED"), node(9, "OPEN")]);
  const read = await readPullRequest(gh.exec, { repo, headOwner: "scott", branch: "feature" });
  expect(read.pullRequest).toMatchObject({ number: 9, state: "open" });
  expect(gh.calls).toEqual(["list", "#9"]);
});

test("a known open pull request is read by number in one call", async () => {
  const gh = github([node(9, "OPEN")]);
  const query = { repo, headOwner: "scott", branch: "feature", open: 9 };
  expect((await readPullRequest(gh.exec, query)).pullRequest).toMatchObject({ number: 9 });
  expect(gh.calls).toEqual(["#9"]);
});

test("a known pull request that merged sends the read back to the branch's list", async () => {
  const gh = github([node(9, "MERGED"), node(11, "OPEN")]);
  const query = { repo, headOwner: "scott", branch: "feature", open: 9 };
  expect((await readPullRequest(gh.exec, query)).pullRequest).toMatchObject({ number: 11 });
  expect(gh.calls).toEqual(["#9", "list", "#11"]);
});

test("a branch with no pull request costs one call", async () => {
  const gh = github([]);
  const read = await readPullRequest(gh.exec, { repo, headOwner: "scott", branch: "feature" });
  expect(read).toEqual({ pullRequest: null, checks: null, threads: null });
  expect(gh.calls).toEqual(["list"]);
});
