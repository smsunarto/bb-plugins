import { expect, test } from "vitest";
import { inboxRow, mergeChanges } from "../core/review.ts";
import type { Exec } from "./github.ts";
import { readInbox } from "./review.ts";

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

test("pinned pull requests ride in the inbox call as variables, and come back marked pinned", async () => {
  let sent: { query: string; variables: Record<string, unknown> } | null = null;
  const exec: Exec = async (_args, { stdin }) => {
    sent = JSON.parse(stdin!);
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        data: {
          mine: { nodes: [node(1, "a")] },
          asked: { nodes: [] },
          p0: { pullRequest: node(7, "pinned") },
          p1: null,
        },
      }),
    };
  };
  const entries = await readInbox(exec, undefined, [
    { owner: "acme", repo: "api", number: 7 },
    { owner: 'x"); drop', repo: "gone", number: 9 },
  ]);
  expect(sent!.query).toContain("p0: repository(owner: $o0, name: $r0) { pullRequest(number: $n0)");
  expect(sent!.query).not.toContain("drop");
  expect(sent!.variables).toMatchObject({ o0: "acme", r0: "api", n0: 7, o1: 'x"); drop' });
  expect(
    entries.map((entry) => [entry.pullRequest.number, entry.mine, entry.pinned ?? false]),
  ).toEqual([
    [1, true, false],
    [7, false, true],
  ]);
  const merged = mergeChanges([entries.map(inboxRow)], "pinned");
  expect(merged.counts.pinned).toBe(1);
  expect(merged.order.map((row) => row.number)).toEqual([7]);
});
