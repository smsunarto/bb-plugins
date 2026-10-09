import { expect, test } from "bun:test";
import { fakeGh } from "../../../test/fake-gh.ts";
import {
  addDraftComment,
  deleteDraft,
  discardReview,
  editDraft,
  replyDraft,
  setViewed,
  submitReview,
} from "./drafts.ts";

const PR = "PR_kwDO";
const HEAD = "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38";
const OLDER = "28c4d3075b5916acdb6974a7e4f5c49d2c274a86";

type Side = "LEFT" | "RIGHT";

/** A review thread as `DraftThreads` reads it: where it sits and its first comment. */
type Thread = {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide: Side;
  startDiffSide: Side | null;
  subjectType: "LINE" | "FILE";
  comments: { nodes: { id: string; body: string; pullRequestReview: { id: string } }[] };
};

/**
 * A GitHub that holds at most one pending review, as the real one does,
 * and counts the drafts written to it. The head is `HEAD` and the base
 * `main` unless `head` and `base` say otherwise, and a review starts on the
 * commit it is asked for. `threads` are the pull request's review threads,
 * read 100 to a page. A new draft thread joins them the way GitHub returns
 * one: a single line has `startLine` equal to `line` and no start side.
 */
function github(
  initial: { id: string; drafts: number; commit?: string } | null = null,
  head = HEAD,
  base = "main",
) {
  let pending = initial && { commit: HEAD, ...initial };
  const threads: Thread[] = [];
  let written = 0;
  const fake = fakeGh({
    graphql: {
      PendingReview: () => ({
        node: {
          headRefOid: head,
          baseRefName: base,
          reviews: {
            nodes: pending
              ? [
                  {
                    id: pending.id,
                    commit: { oid: pending.commit },
                    comments: { totalCount: pending.drafts },
                  },
                ]
              : [],
          },
        },
      }),
      DraftThreads: (variables) => {
        const from = Number(variables.after ?? 0);
        return {
          node: {
            reviewThreads: {
              pageInfo: { hasNextPage: from + 100 < threads.length, endCursor: String(from + 100) },
              nodes: threads.slice(from, from + 100),
            },
          },
        };
      },
      StartReview: (variables) => {
        if (pending) throw new Error("A user can only have one pending review per pull request");
        pending = { id: "PRR_new", drafts: 0, commit: String(variables.commitOID ?? head) };
        return { addPullRequestReview: { pullRequestReview: { id: pending.id } } };
      },
      AddDraftThread: (variables) => {
        const input = variables.input as {
          pullRequestReviewId: string;
          path: string;
          body: string;
          line: number;
          side: Side;
          startLine?: number;
          startSide?: Side;
        };
        written += 1;
        if (pending) pending.drafts += 1;
        const thread = { id: `PRRT_${written}`, comments: { nodes: [{ id: `PRRC_${written}` }] } };
        threads.push({
          id: thread.id,
          path: input.path,
          line: input.line,
          startLine: input.startLine ?? input.line,
          diffSide: input.side,
          startDiffSide: input.startSide ?? null,
          subjectType: "LINE",
          comments: {
            nodes: [
              {
                id: `PRRC_${written}`,
                body: input.body,
                pullRequestReview: { id: input.pullRequestReviewId },
              },
            ],
          },
        });
        return { addPullRequestReviewThread: { thread } };
      },
      ReplyDraft: () => ({ addPullRequestReviewThreadReply: { comment: { id: "PRRC_reply" } } }),
      EditDraft: () => ({
        updatePullRequestReviewComment: { pullRequestReviewComment: { id: "x" } },
      }),
      DeleteDraft: () => ({ deletePullRequestReviewComment: { clientMutationId: null } }),
      SubmitReview: () => ({
        submitPullRequestReview: { pullRequestReview: { url: "https://github.com/o/r/pull/1#r1" } },
      }),
      AddReview: () => ({
        addPullRequestReview: { pullRequestReview: { url: "https://github.com/o/r/pull/1#r2" } },
      }),
      DiscardReview: () => ({ deletePullRequestReview: { clientMutationId: null } }),
      MarkViewed: () => ({ markFileAsViewed: { clientMutationId: null } }),
      UnmarkViewed: () => ({ unmarkFileAsViewed: { clientMutationId: null } }),
    },
  });
  return { ...fake, threads };
}

/**
 * A thread at `at` (by default `draft`'s line) whose comments are
 * `[review, body]` pairs in order, the first one starting it.
 */
function thread(id: string, comments: [string, string][], at: Partial<Thread> = {}): Thread {
  return {
    id,
    path: "src/a.ts",
    line: 12,
    startLine: null,
    diffSide: "RIGHT",
    startDiffSide: null,
    subjectType: "LINE",
    comments: {
      nodes: comments.map(([review, body], index) => ({
        id: `${id}_C${index + 1}`,
        body,
        pullRequestReview: { id: review },
      })),
    },
    ...at,
  };
}

const draft = {
  pullRequestId: PR,
  headRefOid: HEAD,
  baseRefName: "main",
  path: "src/a.ts",
  body: "Handle the empty case.",
  line: 12,
  startLine: null,
  side: "RIGHT" as const,
  startSide: null,
};

test("the first draft starts the viewer's pending review on the commit they read, then adds to it", async () => {
  const { gh, calls } = github();

  expect(await addDraftComment(gh, draft)).toEqual({
    threadId: "PRRT_1",
    commentId: "PRRC_1",
    pendingReview: { id: "PRR_new", draftCount: 1 },
  });

  expect(calls).toEqual([
    { kind: "graphql", operation: "PendingReview", variables: { id: PR } },
    {
      kind: "graphql",
      operation: "StartReview",
      variables: { pullRequestId: PR, commitOID: HEAD },
    },
    {
      kind: "graphql",
      operation: "AddDraftThread",
      variables: {
        input: {
          pullRequestReviewId: "PRR_new",
          path: "src/a.ts",
          body: "Handle the empty case.",
          line: 12,
          side: "RIGHT",
        },
      },
    },
  ]);
});

test("a range draft joins the existing pending review with its start line and side", async () => {
  const { gh, calls } = github({ id: "PRR_open", drafts: 2 });

  expect(
    await addDraftComment(gh, { ...draft, startLine: 8, side: "LEFT", startSide: "LEFT" }),
  ).toEqual({
    threadId: "PRRT_1",
    commentId: "PRRC_1",
    pendingReview: { id: "PRR_open", draftCount: 3 },
  });

  expect(calls.map((call) => (call.kind === "graphql" ? call.operation : call.path))).toEqual([
    "PendingReview",
    "DraftThreads",
    "AddDraftThread",
  ]);
  expect(calls[2]).toMatchObject({
    variables: {
      input: {
        pullRequestReviewId: "PRR_open",
        line: 12,
        side: "LEFT",
        startLine: 8,
        startSide: "LEFT",
      },
    },
  });
});

test("a range from the base to the head keeps its start, even on the same line number", async () => {
  const { gh, calls } = github({ id: "PRR_open", drafts: 0 });

  await addDraftComment(gh, { ...draft, startLine: 10, startSide: "LEFT", line: 10 });

  expect(calls[1]).toMatchObject({
    variables: { input: { line: 10, side: "RIGHT", startLine: 10, startSide: "LEFT" } },
  });
});

test("a push since the lines were picked refuses the draft before anything is written", async () => {
  const { gh, operations } = github(null, "d2f861c0448a9dc36f2bc702ac9af83a703f47e0");

  await expect(addDraftComment(gh, draft)).rejects.toThrow(
    "This pull request has changed since you picked these lines. Reload the diff and pick them again.",
  );
  expect(operations()).toEqual(["PendingReview"]);
});

test("a retarget since the lines were picked refuses the draft before anything is written", async () => {
  // Same head, new base: the base side's line numbers now count another file.
  const { gh, operations, threads } = github({ id: "PRR_open", drafts: 1 }, HEAD, "release");
  // Even a draft already saved on these lines is not handed back.
  threads.push(thread("PRRT_9", [["PRR_open", draft.body]]));

  await expect(addDraftComment(gh, draft)).rejects.toThrow(
    "This pull request has changed since you picked these lines. Reload the diff and pick them again.",
  );
  expect(operations()).toEqual(["PendingReview"]);
});

test("a pending review started on an older commit refuses a draft on the head", async () => {
  const { gh, operations, threads } = github({ id: "PRR_open", drafts: 2, commit: OLDER });
  threads.push(thread("PRRT_9", [["PRR_open", draft.body]]));

  await expect(addDraftComment(gh, draft)).rejects.toThrow(
    "Your pending review is on an older commit, so a new comment would land on the wrong lines. Submit or discard your drafts, then comment again.",
  );
  expect(operations()).toEqual(["PendingReview"]);
});

test("two drafts written at once share one pending review", async () => {
  const { gh, operations } = github();

  const [first, second] = await Promise.all([
    addDraftComment(gh, draft),
    addDraftComment(gh, { ...draft, line: 20 }),
  ]);

  expect([first.threadId, second.threadId]).toEqual(["PRRT_1", "PRRT_2"]);
  expect(operations()).toEqual([
    "PendingReview",
    "StartReview",
    "AddDraftThread",
    "PendingReview",
    "DraftThreads",
    "AddDraftThread",
  ]);
});

test("the same draft sent twice at once writes one thread, and the second only reads", async () => {
  const { gh, operations, threads } = github();

  const [first, second] = await Promise.all([
    addDraftComment(gh, draft),
    addDraftComment(gh, { ...draft, body: "  Handle the empty case.\n" }),
  ]);

  const saved = {
    threadId: "PRRT_1",
    commentId: "PRRC_1",
    pendingReview: { id: "PRR_new", draftCount: 1 },
  };
  expect(first).toEqual(saved);
  expect(second).toEqual(saved);
  expect(threads.map((thread) => thread.id)).toEqual(["PRRT_1"]);
  expect(operations()).toEqual([
    "PendingReview",
    "StartReview",
    "AddDraftThread",
    "PendingReview",
    "DraftThreads",
  ]);
});

test("a range sent again is found, with or without the start side GitHub kept", async () => {
  const { gh, operations, threads } = github({ id: "PRR_open", drafts: 1 });
  // GitHub can leave a range's start side null when it is the end's side.
  threads.push(thread("PRRT_9", [["PRR_open", draft.body]], { startLine: 8 }));

  expect(await addDraftComment(gh, { ...draft, startLine: 8, startSide: "RIGHT" })).toEqual({
    threadId: "PRRT_9",
    commentId: "PRRT_9_C1",
    pendingReview: { id: "PRR_open", draftCount: 1 },
  });
  const across = { ...draft, startLine: 12, startSide: "LEFT" as const };
  const first = await addDraftComment(gh, across);
  expect(await addDraftComment(gh, across)).toEqual(first);
  expect(first).toEqual({
    threadId: "PRRT_1",
    commentId: "PRRC_1",
    pendingReview: { id: "PRR_open", draftCount: 2 },
  });
  expect(operations()).toEqual([
    "PendingReview",
    "DraftThreads",
    "PendingReview",
    "DraftThreads",
    "AddDraftThread",
    "PendingReview",
    "DraftThreads",
  ]);
});

test("a draft reply with the same text does not stand for a new thread", async () => {
  const { gh, operations, threads } = github({ id: "PRR_open", drafts: 2 });
  // The viewer's draft thread on this line says something else, and their draft reply to it matches.
  threads.push(
    thread("PRRT_9", [
      ["PRR_open", "Looks off."],
      ["PRR_open", draft.body],
    ]),
  );

  expect(await addDraftComment(gh, draft)).toEqual({
    threadId: "PRRT_1",
    commentId: "PRRC_1",
    pendingReview: { id: "PRR_open", draftCount: 3 },
  });
  expect(operations()).toEqual(["PendingReview", "DraftThreads", "AddDraftThread"]);
});

test("a submitted comment with the same text does not stand for a new draft", async () => {
  const { gh, operations, threads } = github({ id: "PRR_open", drafts: 1 });
  threads.push(thread("PRRT_9", [["PRR_submitted", draft.body]]));

  expect(await addDraftComment(gh, draft)).toMatchObject({ threadId: "PRRT_1" });
  expect(operations()).toEqual(["PendingReview", "DraftThreads", "AddDraftThread"]);
});

test("the same text on another line, side, range, or file is a new draft", async () => {
  const { gh, threads } = github({ id: "PRR_open", drafts: 2 });
  threads.push(thread("PRRT_9", [["PRR_open", draft.body]]));
  threads.push(
    thread("PRRT_F", [["PRR_open", draft.body]], { path: "src/b.ts", subjectType: "FILE" }),
  );

  const saved = [];
  for (const other of [
    { ...draft, line: 13 },
    { ...draft, side: "LEFT" as const },
    { ...draft, startLine: 10, startSide: "RIGHT" as const },
    { ...draft, startLine: 12, startSide: "LEFT" as const },
    { ...draft, path: "src/b.ts" },
  ]) {
    saved.push(await addDraftComment(gh, other));
  }

  expect(saved.map(({ threadId, pendingReview }) => [threadId, pendingReview.draftCount])).toEqual([
    ["PRRT_1", 3],
    ["PRRT_2", 4],
    ["PRRT_3", 5],
    ["PRRT_4", 6],
    ["PRRT_5", 7],
  ]);
});

test("a draft past the first hundred threads is found on the next page", async () => {
  const { gh, calls, threads } = github({ id: "PRR_open", drafts: 1 });
  for (let line = 1; line <= 100; line++) {
    threads.push(thread(`PRRT_old${line}`, [["PRR_submitted", "Earlier."]], { line }));
  }
  threads.push(thread("PRRT_9", [["PRR_open", draft.body]]));

  expect(await addDraftComment(gh, draft)).toEqual({
    threadId: "PRRT_9",
    commentId: "PRRT_9_C1",
    pendingReview: { id: "PRR_open", draftCount: 1 },
  });
  expect(calls.slice(1)).toEqual([
    { kind: "graphql", operation: "DraftThreads", variables: { id: PR, after: null } },
    { kind: "graphql", operation: "DraftThreads", variables: { id: PR, after: "100" } },
  ]);
});

test("a draft past a thousand threads is still found, so a retry never writes it twice", async () => {
  const { gh, calls, threads } = github({ id: "PRR_open", drafts: 1 });
  for (let line = 1; line <= 1500; line++) {
    threads.push(thread(`PRRT_old${line}`, [["PRR_submitted", "Earlier."]], { line }));
  }
  threads.push(thread("PRRT_9", [["PRR_open", draft.body]]));

  expect(await addDraftComment(gh, draft)).toEqual({
    threadId: "PRRT_9",
    commentId: "PRRT_9_C1",
    pendingReview: { id: "PRR_open", draftCount: 1 },
  });
  expect(
    calls.filter((call) => call.kind === "graphql" && call.operation === "DraftThreads"),
  ).toHaveLength(16);
});

test("a pull request with more threads than the scan reads refuses the draft and writes nothing", async () => {
  const { gh, calls, threads } = github({ id: "PRR_open", drafts: 1 });
  for (let line = 1; line <= 3001; line++) {
    threads.push(thread(`PRRT_old${line}`, [["PRR_submitted", "Earlier."]], { line }));
  }

  await expect(addDraftComment(gh, draft)).rejects.toThrow(
    "This pull request has too many review threads to check that this draft is not already saved. Comment on GitHub instead.",
  );
  expect(calls.some((call) => call.kind === "graphql" && call.operation === "AddDraftThread")).toBe(
    false,
  );
});

test("a draft GitHub does not attach to the diff is reported, not returned as saved", async () => {
  const { gh } = fakeGh({
    graphql: {
      PendingReview: {
        node: {
          headRefOid: HEAD,
          baseRefName: "main",
          reviews: {
            nodes: [{ id: "PRR_open", commit: { oid: HEAD }, comments: { totalCount: 0 } }],
          },
        },
      },
      AddDraftThread: { addPullRequestReviewThread: { thread: null } },
    },
  });
  await expect(addDraftComment(gh, draft)).rejects.toThrow(
    "GitHub did not save the comment. Is that line in the diff?",
  );
});

test("a draft reply starts a pending review on the head when there is none", async () => {
  const { gh, calls } = github();

  expect(await replyDraft(gh, { pullRequestId: PR, threadId: "PRRT_9", body: "Agreed." })).toEqual({
    commentId: "PRRC_reply",
  });
  expect(calls.slice(1)).toEqual([
    {
      kind: "graphql",
      operation: "StartReview",
      variables: { pullRequestId: PR, commitOID: null },
    },
    {
      kind: "graphql",
      operation: "ReplyDraft",
      variables: {
        input: {
          pullRequestReviewId: "PRR_new",
          pullRequestReviewThreadId: "PRRT_9",
          body: "Agreed.",
        },
      },
    },
  ]);
});

test("editing and deleting a draft address the comment by id", async () => {
  const { gh, calls } = github();
  await editDraft(gh, "PRRC_1", "Handle the empty list.");
  await deleteDraft(gh, "PRRC_1");
  expect(calls).toEqual([
    {
      kind: "graphql",
      operation: "EditDraft",
      variables: { id: "PRRC_1", body: "Handle the empty list." },
    },
    { kind: "graphql", operation: "DeleteDraft", variables: { id: "PRRC_1" } },
  ]);
});

test("submitting sends the pending review with its drafts", async () => {
  const { gh, calls } = github({ id: "PRR_open", drafts: 3 });

  const result = await submitReview(gh, {
    pullRequestId: PR,
    headRefOid: HEAD,
    event: "REQUEST_CHANGES",
    body: "  ",
  });

  expect(result).toEqual({ url: "https://github.com/o/r/pull/1#r1" });
  expect(calls[1]).toEqual({
    kind: "graphql",
    operation: "SubmitReview",
    variables: { input: { pullRequestReviewId: "PRR_open", event: "REQUEST_CHANGES", body: "" } },
  });
});

test("an approval with no drafts posts a new review on the commit the reader saw", async () => {
  const { gh, calls } = github();

  const result = await submitReview(gh, {
    pullRequestId: PR,
    headRefOid: HEAD,
    event: "APPROVE",
    body: "",
  });

  expect(result).toEqual({ url: "https://github.com/o/r/pull/1#r2" });
  expect(calls[1]).toEqual({
    kind: "graphql",
    operation: "AddReview",
    variables: { input: { pullRequestId: PR, commitOID: HEAD, event: "APPROVE", body: "" } },
  });
});

test("a comment or change request with nothing in it is refused before GitHub sees it", async () => {
  const { gh, operations } = github({ id: "PRR_open", drafts: 0 });

  await expect(
    submitReview(gh, { pullRequestId: PR, headRefOid: HEAD, event: "COMMENT", body: " " }),
  ).rejects.toThrow("Write a comment or add a draft before submitting.");
  await expect(
    submitReview(gh, { pullRequestId: PR, headRefOid: HEAD, event: "REQUEST_CHANGES", body: "" }),
  ).rejects.toThrow(
    "Say what needs to change: write a comment or add a draft before requesting changes.",
  );
  expect(operations()).toEqual(["PendingReview", "PendingReview"]);
});

test("discarding deletes the pending review, and does nothing without one", async () => {
  const withDrafts = github({ id: "PRR_open", drafts: 2 });
  await discardReview(withDrafts.gh, PR);
  expect(withDrafts.calls[1]).toEqual({
    kind: "graphql",
    operation: "DiscardReview",
    variables: { id: "PRR_open" },
  });

  const none = github();
  await discardReview(none.gh, PR);
  expect(none.operations()).toEqual(["PendingReview"]);
});

test("a pull request id that resolves to nothing is reported as gone", async () => {
  const { gh } = fakeGh({ graphql: { PendingReview: { node: null } } });
  await expect(discardReview(gh, "PR_gone")).rejects.toMatchObject({
    code: "not-found",
    message: "That pull request no longer exists.",
  });
});

test("marking a file viewed and unviewed", async () => {
  const { gh, calls } = github();
  expect(await setViewed(gh, { pullRequestId: PR, path: "a.ts", viewed: true })).toBe("viewed");
  expect(await setViewed(gh, { pullRequestId: PR, path: "a.ts", viewed: false })).toBe("unviewed");
  expect(calls).toEqual([
    { kind: "graphql", operation: "MarkViewed", variables: { pullRequestId: PR, path: "a.ts" } },
    { kind: "graphql", operation: "UnmarkViewed", variables: { pullRequestId: PR, path: "a.ts" } },
  ]);
});
