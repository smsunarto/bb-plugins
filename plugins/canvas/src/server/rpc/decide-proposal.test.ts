import { expect, test } from "bun:test";
import { fakeBb, fileKeyOf } from "../fake-bb.ts";
import { decideProposal } from "./decide-proposal.ts";

test("decision RPC applies an independently reviewable edit in thread storage", async () => {
  const source = { kind: "thread-storage", threadId: "thread", path: "canvas.mdx" } as const;
  const proposal = {
    id: "one",
    title: "Edit",
    author: "agent",
    createdAtMs: 1,
    before: "Before",
    after: "After",
    status: "pending",
  } as const;
  const bb = fakeBb({
    threads: { thread: { hostId: "remote", storageRootPath: "/storage" } },
    files: {
      [fileKeyOf("remote", "/storage", "/storage/canvas.mdx")]: { content: "Before" },
      [fileKeyOf("remote", "/storage", "/storage/canvas.mdx.suggestions.json")]: {
        content: JSON.stringify({ version: 1, proposals: [proposal] }),
      },
    },
  });
  const result = await decideProposal.execute(
    { bb },
    { source, proposal, decision: "accept", expectedContent: "Before" },
  );
  expect(result.content).toBe("After");
  expect(
    bb.calls.filesWrite.every((call) => call.hostId === "remote" && call.rootPath === "/storage"),
  ).toBe(true);
});
