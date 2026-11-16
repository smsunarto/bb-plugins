import { expect, test } from "vitest";
import { reviewReadSchema } from "../contract/host.ts";
import type { Exec } from "../forge/github.ts";
import { readInbox, runReviewRead } from "../forge/review.ts";

const node = (number: number, branch: string) => ({
  number,
  url: `https://github.com/acme/api/pull/${number}`,
  title: `PR ${number}`,
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-11-10T00:00:00Z",
  headRefName: branch,
  baseRefName: "main",
  headRefOid: "c0ffee1",
  repository: { name: "api", owner: { login: "acme" } },
  headRepositoryOwner: { login: "acme" },
  author: { login: "mira" },
});

function fakeGh() {
  const sent: { query: string; variables: Record<string, unknown> }[] = [];
  const exec: Exec = async (_args, { stdin }) => {
    sent.push(JSON.parse(stdin!));
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        data: {
          mine: { nodes: [node(1, "a"), node(2, "both")] },
          asked: { nodes: [node(2, "both"), node(3, "c"), null] },
        },
      }),
    };
  };
  return { exec, sent };
}

test("the inbox is the account's own and asked-for pull requests, one entry each", async () => {
  const gh = fakeGh();
  const entries = await readInbox(gh.exec);
  expect(Object.keys(gh.sent[0]!.variables).sort()).toEqual(["asked", "mine"]);
  expect(gh.sent[0]!.query).toMatch(/^query\(\$mine: String!, \$asked: String!\) \{/);
  expect(entries.map((entry) => [entry.pullRequest.number, entry.mine, entry.asked])).toEqual([
    [1, true, false],
    [2, true, true],
    [3, false, true],
  ]);
  expect(entries.some((entry) => "pinned" in entry)).toBe(false);
});

test("a server from before pins were removed still sends them: the host reads the same inbox", async () => {
  const old = reviewReadSchema.parse({
    kind: "inbox",
    pins: [{ owner: "acme", repo: "api", number: 7 }],
  });
  const gh = fakeGh();
  const answer = await runReviewRead(gh.exec, old);
  expect(Object.keys(gh.sent[0]!.variables).sort()).toEqual(["asked", "mine"]);
  expect(
    answer.kind === "inbox" && answer.entries.map((entry) => entry.pullRequest.number),
  ).toEqual([1, 2, 3]);
});
