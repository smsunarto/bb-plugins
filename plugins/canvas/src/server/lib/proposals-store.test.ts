import { expect, test } from "bun:test";
import { fakeBb, fileKeyOf, type FakeBbOptions } from "../fake-bb.ts";
import { decideProposal, readProposals } from "./proposals-store.ts";
import { applyReplacement, type Proposal } from "../../shared/proposals.ts";

const source = { kind: "host", hostId: null, path: "/review.canvas.mdx" } as const;
const documentKey = fileKeyOf(undefined, undefined, source.path);
const sidecarKey = `${documentKey}.suggestions.json`;
const first: Proposal = {
  id: "edit-one",
  title: "Clarify evidence",
  author: "agent",
  createdAtMs: 1,
  before: "Old evidence.",
  after: "Verified evidence.",
  status: "pending",
};
const second: Proposal = {
  ...first,
  id: "edit-two",
  title: "Second edit",
  before: "Other paragraph.",
  after: "Revised paragraph.",
};
const content = "# Report\n\nOld evidence.\n\nOther paragraph.\n";
function fixture(options: Partial<FakeBbOptions> = {}) {
  return fakeBb({
    files: {
      [documentKey]: { content },
      [sidecarKey]: { content: JSON.stringify({ version: 1, proposals: [first, second] }) },
    },
    ...options,
  });
}
test("accepts one proposal, preserves the other and unrelated source", async () => {
  const bb = fixture();
  const result = await decideProposal(bb, {
    source,
    proposal: first,
    decision: "accept",
    expectedContent: content,
  });
  expect(result.content).toBe(content.replace(first.before, first.after));
  expect(result.file.proposals.map((p) => p.status)).toEqual(["accepted", "pending"]);
  expect(result.file.proposals[0]?.receipt?.afterSha256).toBe(result.sha256);
  const retry = await decideProposal(bb, {
    source,
    proposal: first,
    decision: "accept",
    expectedContent: result.content,
  });
  expect(retry.content).toBe(result.content);
});
test("reject does not write the canvas", async () => {
  const bb = fixture();
  const result = await decideProposal(bb, {
    source,
    proposal: second,
    decision: "reject",
    expectedContent: "unsaved text",
  });
  expect(result.file.proposals[1]?.status).toBe("rejected");
  expect(bb.calls.filesWrite.every((call) => call.path.endsWith(".suggestions.json"))).toBe(true);
});
test("refuses stale source, stale proposals, missing or ambiguous replacements", async () => {
  await expect(
    decideProposal(fixture(), {
      source,
      proposal: first,
      decision: "accept",
      expectedContent: "unsaved text",
    }),
  ).rejects.toThrow("unsaved");
  await expect(
    decideProposal(fixture(), {
      source,
      proposal: { ...first, after: "Unreviewed" },
      decision: "accept",
      expectedContent: content,
    }),
  ).rejects.toThrow("proposal changed");
  expect(() => applyReplacement("nothing", first)).toThrow("no longer matches");
  expect(() => applyReplacement(first.before + first.before, first)).toThrow("more than once");
  expect(() => applyReplacement("aaa", { before: "aa", after: "x" })).toThrow("more than once");
});
test("source CAS preserves a simultaneous direct file edit", async () => {
  const bb = fixture({
    beforeWrite(args, store) {
      if (args.path === source.path)
        store.set(documentKey, { content: "Agent changed the canvas" });
    },
  });
  await expect(
    decideProposal(bb, { source, proposal: first, decision: "accept", expectedContent: content }),
  ).rejects.toThrow("changed while accepting");
  expect(bb.store.get(documentKey)).toEqual({ content: "Agent changed the canvas" });
});
test("recovers after interrupted receipt without applying replacement twice", async () => {
  let fail = true;
  const bb = fixture({
    beforeWrite(args) {
      if (fail && args.path.endsWith(".suggestions.json") && args.content.includes('"accepted"'))
        throw new Error("Disconnected");
    },
  });
  const proposal = { ...first, after: `${first.before} More context.` };
  bb.store.set(sidecarKey, { content: JSON.stringify({ version: 1, proposals: [proposal] }) });
  await expect(
    decideProposal(bb, { source, proposal, decision: "accept", expectedContent: content }),
  ).rejects.toThrow("Disconnected");
  fail = false;
  await expect(
    decideProposal(bb, {
      source,
      proposal,
      decision: "accept",
      expectedContent: "New unsaved work",
    }),
  ).rejects.toThrow("newer unsaved changes");
  const result = await decideProposal(bb, {
    source,
    proposal,
    decision: "accept",
    expectedContent: content,
  });
  expect(result.content).toBe(content.replace(proposal.before, proposal.after));
  expect(result.file.proposals[0]?.status).toBe("accepted");
});
test("sidecar CAS preserves concurrent proposals and never writes source on conflict", async () => {
  const bb = fixture({
    beforeWrite(args, store) {
      if (args.path.endsWith(".suggestions.json"))
        store.set(sidecarKey, { content: JSON.stringify({ version: 1, proposals: [second] }) });
    },
  });
  await expect(
    decideProposal(bb, { source, proposal: first, decision: "accept", expectedContent: content }),
  ).rejects.toThrow("Suggestions changed");
  expect(bb.calls.filesWrite.some((call) => call.path === source.path)).toBe(false);
});
test("missing sidecar is empty, malformed or duplicate IDs are errors", async () => {
  expect((await readProposals(fakeBb({}), source)).file.proposals).toEqual([]);
  const bb = fixture();
  bb.store.set(sidecarKey, { content: "broken" });
  await expect(readProposals(bb, source)).rejects.toThrow();
  bb.store.set(sidecarKey, { content: JSON.stringify({ version: 1, proposals: [first, first] }) });
  await expect(readProposals(bb, source)).rejects.toThrow("unique");
});
