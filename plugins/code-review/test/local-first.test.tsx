import "./dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient, hashKey } from "@tanstack/react-query";
import { PluginQueryBoundary, pluginQueryClient } from "@bb-kit/core/rpc/query";
import { installLocalCache, readDraftText, writeDraftText } from "../src/app/local-cache.ts";
import { inbox, pullRequest } from "./app-fixtures.ts";
import { inboxTabRegistration } from "./registrations.ts";
import { parsePrSubPath } from "../src/shared/schema.ts";
import type { PullRequest, Inbox, ChangedFiles } from "../src/shared/schema.ts";

const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { renderSlot, loadPluginApp } = await import("@get-bb/plugin-sdk/testing/app");
const { rpc } = await import("../src/app/rpc.ts");
const {
  useDraftPreview,
  useAddDraft,
  useEditDraft,
  useDeleteDraft,
  useReplyDraft,
  DraftSyncNotice,
} = await import("../src/app/draft-sync.tsx");
const { SubmitReviewButton } = await import("../src/app/submit-review.tsx");
const { TooltipProvider } = await import("../src/app/components/ui/tooltip.tsx");
const { NewCommentForm, useDraftText } = await import("../src/app/comment-form.tsx");

const disposers: (() => void)[] = [];
beforeEach(() => {
  pluginQueryClient.clear();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  pluginQueryClient.clear();
});
const input = { account: pullRequest.account, ref: pullRequest.ref };
const prKey = rpc.pullRequest.queryKey(input);

function localClient() {
  const client = new QueryClient();
  disposers.push(() => client.clear());
  return client;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("confirmed snapshots restore status, inbox, PR, diff revision and checks synchronously", () => {
  const writer = localClient();
  const stop = installLocalCache(writer, window.localStorage);
  writer.setQueryData(["status"], { ok: true, login: "scott", accounts: ["scott"] });
  writer.setQueryData(["inbox"], inbox);
  writer.setQueryData(prKey, pullRequest);
  writer.setQueryData(rpc.changedFiles.queryKey(input), {
    headRefOid: "old-head",
    baseRefName: "old-base",
    comparison: null,
    files: [],
  });
  writer.setQueryData(rpc.checks.queryKey(input), {
    headRefOid: "old-head",
    state: "success",
    checks: [],
  });
  stop();
  const reader = localClient();
  disposers.push(installLocalCache(reader, window.localStorage));
  expect(reader.getQueryData<Inbox>(["inbox"])).toEqual(inbox);
  expect(reader.getQueryData<PullRequest>(prKey)).toEqual(pullRequest);
  expect(reader.getQueryData(["status"])).toMatchObject({ ok: true });
  expect(reader.getQueryData<ChangedFiles>(rpc.changedFiles.queryKey(input))).toEqual({
    headRefOid: "old-head",
    baseRefName: "old-base",
    comparison: null,
    files: [],
  });
  expect(reader.getQueryData(rpc.checks.queryKey(input))).toMatchObject({ headRefOid: "old-head" });
});

test("malformed, expired, other-version and wrong-account snapshots never enter the cache", () => {
  const storage = window.localStorage;
  storage.setItem(
    `code-review:snapshot:v1:${hashKey(prKey)}`,
    JSON.stringify({
      method: "pullRequest",
      input,
      updatedAt: Date.now(),
      data: { ...pullRequest, account: "other" },
    }),
  );
  storage.setItem('code-review:snapshot:v1:["status"]', "{broken");
  storage.setItem(
    'code-review:snapshot:v1:["inbox"]',
    JSON.stringify({ method: "inbox", data: inbox, updatedAt: Date.now() - 8 * 24 * 60 * 60_000 }),
  );
  storage.setItem('code-review:snapshot:v0:["inbox"]', JSON.stringify(inbox));
  const client = localClient();
  disposers.push(installLocalCache(client, storage));
  expect(client.getQueryCache().getAll()).toHaveLength(0);
});

test("accounts retain different copies of the same PR", () => {
  const writer = localClient();
  const stop = installLocalCache(writer, window.localStorage);
  writer.setQueryData(prKey, pullRequest);
  const otherInput = { ...input, account: "work" };
  writer.setQueryData(rpc.pullRequest.queryKey(otherInput), {
    ...pullRequest,
    account: "work",
    body: "Work-only pending review",
  });
  stop();
  const reader = localClient();
  disposers.push(installLocalCache(reader, window.localStorage));
  expect(reader.getQueryData<PullRequest>(prKey)).toEqual(pullRequest);
  expect(reader.getQueryData(rpc.pullRequest.queryKey(otherInput))).toMatchObject({
    account: "work",
    body: "Work-only pending review",
  });
});

test("bounded persistence evicts old PRs without losing the newest copy", () => {
  const writer = localClient();
  const stop = installLocalCache(writer, window.localStorage);
  for (let number = 1; number <= 45; number++) {
    const ref = { ...input.ref, number };
    writer.setQueryData(rpc.pullRequest.queryKey({ ...input, ref }), { ...pullRequest, ref });
  }
  stop();
  expect(window.localStorage.length).toBeLessThanOrEqual(32);
  const reader = localClient();
  disposers.push(installLocalCache(reader, window.localStorage));
  expect(
    reader.getQueryData(rpc.pullRequest.queryKey({ ...input, ref: { ...input.ref, number: 45 } })),
  ).toBeDefined();
});

test("denied storage degrades to ordinary in-memory reads", () => {
  const denied = new Proxy({} as Storage, {
    get() {
      throw new Error("Denied");
    },
  });
  const client = localClient();
  const stop = installLocalCache(client, denied);
  client.setQueryData(prKey, pullRequest);
  expect(() => stop()).not.toThrow();
  expect(client.getQueryData<PullRequest>(prKey)).toEqual(pullRequest);
});

test("snapshots read as an account gh signed out of are forgotten on disk and in memory", () => {
  const workInput = { ...input, account: "work" };
  const writer = localClient();
  const save = installLocalCache(writer, window.localStorage);
  writer.setQueryData(["status"], { ok: true, login: "scott", accounts: ["scott", "work"] });
  writer.setQueryData(prKey, pullRequest);
  writer.setQueryData(rpc.pullRequest.queryKey(workInput), { ...pullRequest, account: "work" });
  save();

  const reader = localClient();
  const stop = installLocalCache(reader, window.localStorage);
  expect(reader.getQueryData(rpc.pullRequest.queryKey(workInput))).toBeDefined();
  reader.setQueryData(["status"], { ok: true, login: "Scott", accounts: ["Scott"] });
  stop();
  expect(reader.getQueryData(rpc.pullRequest.queryKey(workInput))).toBeUndefined();
  expect(reader.getQueryData<PullRequest>(prKey)).toEqual(pullRequest);

  const after = localClient();
  disposers.push(installLocalCache(after, window.localStorage));
  expect(after.getQueryData(rpc.pullRequest.queryKey(workInput))).toBeUndefined();
  expect(after.getQueryData<PullRequest>(prKey)).toEqual(pullRequest);
});

test("signing gh out of every account forgets every snapshot, the account gate too", () => {
  const writer = localClient();
  const save = installLocalCache(writer, window.localStorage);
  writer.setQueryData(["status"], { ok: true, login: "scott", accounts: ["scott"] });
  writer.setQueryData(["inbox"], inbox);
  writer.setQueryData(prKey, pullRequest);
  save();

  const reader = localClient();
  const stop = installLocalCache(reader, window.localStorage);
  reader.setQueryData(["status"], { ok: false, reason: "unauthenticated", message: "Signed out" });
  stop();
  expect(reader.getQueryData<PullRequest>(prKey)).toBeUndefined();

  const after = localClient();
  disposers.push(installLocalCache(after, window.localStorage));
  expect(after.getQueryCache().getAll()).toHaveLength(0);
});

test("unsent text persists separately per account and clears only when asked", () => {
  writeDraftText("edit:scott:C1", "Keep my draft");
  expect(readDraftText("edit:work:C1")).toBe("");
  expect(readDraftText("edit:scott:C1")).toBe("Keep my draft");
  writeDraftText("edit:scott:C1", "");
  expect(readDraftText("edit:scott:C1")).toBe("");
});

const thread = {
  id: "T1",
  path: "src/a.ts",
  line: 1,
  startLine: null,
  startSide: null,
  side: "RIGHT" as const,
  originalLine: 1,
  isResolved: false,
  isOutdated: false,
  isFileLevel: false,
  diffHunk: "",
  comments: [
    {
      id: "C1",
      body: "Original",
      author: { login: "scott", avatarUrl: null },
      url: pullRequest.url,
      createdAt: pullRequest.createdAt,
      isDraft: true,
    },
  ],
};
const withDraft: PullRequest = {
  ...pullRequest,
  threads: [thread],
  pendingReview: { id: "R1", body: "", draftCount: 1 },
};
const newInput = {
  account: "scott",
  pullRequestId: pullRequest.id,
  headRefOid: pullRequest.headRefOid,
  baseRefName: pullRequest.baseRefName,
  path: "src/a.ts",
  body: "New draft",
  line: 1,
  side: "RIGHT" as const,
  startLine: null,
  startSide: null,
};

function DraftHarness() {
  const query = rpc.pullRequest.useQuery(input);
  const pr = useDraftPreview(query.data)!;
  const add = useAddDraft(pr);
  const edit = useEditDraft(pr);
  const remove = useDeleteDraft(pr);
  const reply = useReplyDraft(pr);
  return (
    <>
      <DraftSyncNotice pr={pr} />
      <output data-testid="comments">{JSON.stringify(pr.threads)}</output>
      <output data-testid="count">{pr.pendingReview?.draftCount ?? 0}</output>
      <button onClick={() => add.mutate(newInput)}>Add</button>
      <button onClick={() => edit.mutate({ account: "scott", commentId: "C1", body: "Edited" })}>
        Edit
      </button>
      <button onClick={() => remove.mutate({ account: "scott", commentId: "C1" })}>Delete</button>
      <button
        onClick={() =>
          reply.mutate({
            account: "scott",
            pullRequestId: pr.id,
            threadId: "T1",
            body: "Reply draft",
          })
        }
      >
        Reply
      </button>
      <TooltipProvider>
        <SubmitReviewButton pr={pr} />
      </TooltipProvider>
    </>
  );
}
function draftSlot(handlers: Record<string, (...args: never[]) => unknown>) {
  pluginQueryClient.setQueryData(prKey, withDraft);
  const slot = renderSlot(
    {
      component: () => (
        <PluginQueryBoundary>
          <DraftHarness />
        </PluginQueryBoundary>
      ),
    },
    {},
    { rpc: { pullRequest: () => withDraft, ...handlers } as never },
  );
  disposers.push(() => slot.lifecycle.unmount());
  return slot;
}

test("edit previews immediately, survives a concurrent GitHub read, and rolls back to that read on failure", async () => {
  const write = deferred<{ ok: true }>();
  const slot = draftSlot({ editDraft: () => write.promise });
  fireEvent.click(slot.getByText("Edit"));
  await waitFor(() => expect(slot.getByTestId("comments").textContent).toContain("Edited"));
  expect(pluginQueryClient.getQueryData<PullRequest>(prKey)?.threads[0]?.comments[0]?.body).toBe(
    "Original",
  );
  act(() =>
    pluginQueryClient.setQueryData(prKey, {
      ...withDraft,
      title: "Remote change",
      threads: [
        { ...thread, comments: [{ ...thread.comments[0]!, body: "Changed on github.com" }] },
      ],
    }),
  );
  await waitFor(() => expect(slot.getByTestId("comments").textContent).toContain("Edited"));
  write.reject(new Error("GitHub refused the edit"));
  await slot.findByText("GitHub did not save your draft");
  await waitFor(() =>
    expect(slot.getByTestId("comments").textContent).toContain("Changed on github.com"),
  );
  expect(pluginQueryClient.getQueryData<PullRequest>(prKey)?.title).toBe("Remote change");
});

test("delete disappears before GitHub answers, then restores on failure", async () => {
  const write = deferred<{ ok: true }>();
  const slot = draftSlot({ deleteDraft: () => write.promise });
  fireEvent.click(slot.getByText("Delete"));
  await waitFor(() => expect(slot.getByTestId("comments").textContent).toBe("[]"));
  expect(slot.getByTestId("count").textContent).toBe("0");
  write.reject(new Error("Offline"));
  await slot.findByText("GitHub did not save your draft");
  expect(slot.getByTestId("comments").textContent).toContain("Original");
});

test("new comments preview while saving, keep their revision, and never persist as confirmed", async () => {
  const write = deferred<{
    threadId: string;
    commentId: string;
    pendingReview: { id: string; draftCount: number };
  }>();
  const slot = draftSlot({ addDraftComment: () => write.promise });
  fireEvent.click(slot.getByText("Add"));
  await waitFor(() => expect(slot.getByTestId("comments").textContent).toContain("New draft"));
  act(() => pluginQueryClient.setQueryData(prKey, { ...withDraft, headRefOid: "new-head" }));
  await waitFor(() =>
    expect(slot.getByTestId("comments").textContent).toContain('"isOutdated":true'),
  );
  expect(pluginQueryClient.getQueryData<PullRequest>(prKey)?.threads).toHaveLength(1);
  write.reject(new Error("Head moved"));
  await slot.findByText("GitHub did not save your draft");
  expect(slot.getByTestId("comments").textContent).not.toContain("New draft");
});

test("one failed edit does not erase another pending reply", async () => {
  const edit = deferred<{ ok: true }>();
  const reply = deferred<{
    commentId: string;
    pendingReview: { id: string; draftCount: number };
  }>();
  const slot = draftSlot({ editDraft: () => edit.promise, replyDraft: () => reply.promise });
  fireEvent.click(slot.getByText("Edit"));
  fireEvent.click(slot.getByText("Reply"));
  await waitFor(() => expect(slot.getByTestId("comments").textContent).toContain("Reply draft"));
  edit.reject(new Error("Edit denied"));
  await slot.findByText("GitHub did not save your draft");
  expect(slot.getByTestId("comments").textContent).toContain("Reply draft");
  expect(slot.getByTestId("comments").textContent).toContain("Original");
  reply.reject(new Error("Reply denied"));
  await waitFor(() =>
    expect(slot.getByTestId("comments").textContent).not.toContain("Reply draft"),
  );
});

test("review submission cannot overtake an unconfirmed draft", async () => {
  const write = deferred<{ ok: true }>();
  let submits = 0;
  const slot = draftSlot({
    editDraft: () => write.promise,
    submitReview: () => {
      submits++;
      return { url: null };
    },
  });
  fireEvent.click(slot.getByText("Edit"));
  fireEvent.click(slot.getByRole("button", { name: /Submit review/ }));
  await slot.findByRole("textbox", { name: "Review summary" });
  fireEvent.change(slot.getByRole("textbox", { name: "Review summary" }), {
    target: { value: "Review" },
  });
  fireEvent.keyDown(slot.getByRole("textbox", { name: "Review summary" }), {
    key: "Enter",
    ctrlKey: true,
  });
  expect(submits).toBe(0);
  write.reject(new Error("Denied"));
  await slot.findByText("GitHub did not save your draft");
});

test("successful saves clear recovery text after the form unmounts without waiting for PR revalidation", async () => {
  const write = deferred<{
    threadId: string;
    commentId: string;
    pendingReview: { id: string; draftCount: number };
  }>();
  const laterRead = deferred<PullRequest>();
  pluginQueryClient.setQueryData(prKey, pullRequest);
  function Form() {
    return (
      <PluginQueryBoundary>
        <NewCommentForm
          pr={pullRequest}
          path="src/a.ts"
          headRefOid={pullRequest.headRefOid}
          baseRefName={pullRequest.baseRefName}
          target={{ line: 1, side: "RIGHT", startLine: null, startSide: null }}
          onSaved={() => {}}
          onClose={() => {}}
        />
      </PluginQueryBoundary>
    );
  }
  const slot = renderSlot(
    { component: Form },
    {},
    {
      rpc: { addDraftComment: () => write.promise, pullRequest: () => laterRead.promise } as never,
    },
  );
  fireEvent.change(slot.getByRole("textbox"), { target: { value: "Keep until saved" } });
  fireEvent.click(slot.getByRole("button", { name: "Add review comment" }));
  await waitFor(() =>
    expect(slot.rpcCalls.some((call) => call.method === "addDraftComment")).toBe(true),
  );
  slot.lifecycle.unmount();
  write.resolve({
    threadId: "Tnew",
    commentId: "Cnew",
    pendingReview: { id: "R1", draftCount: 1 },
  });
  await waitFor(() => expect(readDraftText(`new:scott:${pullRequest.id}:src/a.ts`)).toBe(""));
  expect(pluginQueryClient.getQueryData<PullRequest>(prKey)?.threads[0]?.comments[0]?.body).toBe(
    "Keep until saved",
  );
});

test("a restored inbox renders while GitHub status and inbox are still pending", async () => {
  const stop = installLocalCache(localClient(), window.sessionStorage);
  stop();
  // Simulates the module's synchronous restoration on a new app document.
  const writer = localClient();
  const save = installLocalCache(writer, window.sessionStorage);
  writer.setQueryData(["inbox"], inbox, { updatedAt: Date.now() - 60_000 });
  save();
  disposers.push(installLocalCache(pluginQueryClient, window.sessionStorage));
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const wait = deferred<never>();
  const slot = renderSlot(
    inboxTabRegistration(app),
    { subPath: "" },
    {
      rpc: {
        status: () => wait.promise,
        inbox: () => wait.promise,
        localBranches: () => ({ available: false, reason: "Test" }),
      } as never,
    },
  );
  disposers.push(() => slot.lifecycle.unmount());
  expect(slot.getByText("Rate-limit the login endpoint")).toBeTruthy();
  expect(slot.queryByText("Connecting to GitHub…")).toBeNull();
});

test("a newer snapshot from another window updates only its account's confirmed copy", () => {
  const client = localClient();
  client.setQueryData(prKey, pullRequest, { updatedAt: Date.now() - 1000 });
  disposers.push(installLocalCache(client, window.localStorage));
  const key = `code-review:snapshot:v1:${hashKey(prKey)}`;
  const value = JSON.stringify({
    method: "pullRequest",
    input,
    updatedAt: Date.now(),
    data: { ...pullRequest, title: "Changed in another window" },
  });
  window.localStorage.setItem(key, value);
  window.dispatchEvent(
    new window.StorageEvent("storage", { key, newValue: value, storageArea: window.localStorage }),
  );
  expect(client.getQueryData<PullRequest>(prKey)?.title).toBe("Changed in another window");
  expect(
    client.getQueryData(rpc.pullRequest.queryKey({ ...input, account: "work" })),
  ).toBeUndefined();
});

test("a cached PR still opens while status is unavailable and no inbox was retained", async () => {
  pluginQueryClient.setQueryData(prKey, pullRequest);
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const pending = deferred<never>();
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "@scott/acme/api/pull/42" },
    {
      rpc: {
        status: () => ({ ok: false, reason: "failed", message: "Offline" }),
        pullRequest: () => pending.promise,
        checks: () => pending.promise,
        agentActivity: () => pending.promise,
      } as never,
    },
  );
  disposers.push(() => slot.lifecycle.unmount());
  expect(slot.getByRole("heading", { name: /Rate-limit the login endpoint/ })).toBeTruthy();
  await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "status")).toBe(true));
  expect(slot.queryByText("Could not reach GitHub")).toBeNull();
});

test("a cached PR does not open once gh reports no signed-in account", async () => {
  pluginQueryClient.setQueryData(["inbox"], inbox);
  pluginQueryClient.setQueryData(prKey, pullRequest);
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const pending = deferred<never>();
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "@scott/acme/api/pull/42" },
    {
      rpc: {
        status: () => ({ ok: false, reason: "unauthenticated", message: "Not signed in" }),
        pullRequest: () => pending.promise,
        checks: () => pending.promise,
        agentActivity: () => pending.promise,
      } as never,
    },
  );
  disposers.push(() => slot.lifecycle.unmount());
  expect(await slot.findByText("Sign in to GitHub")).toBeTruthy();
  expect(slot.queryByRole("heading", { name: /Rate-limit the login endpoint/ })).toBeNull();
});

test("pending draft previews and failures never show under a different account", async () => {
  const write = deferred<{ ok: true }>();
  const slot = draftSlot({ editDraft: () => write.promise });
  fireEvent.click(slot.getByText("Edit"));
  await waitFor(() => expect(slot.getByTestId("comments").textContent).toContain("Edited"));
  const other = { ...withDraft, account: "work" };
  function Other() {
    const pr = useDraftPreview(other)!;
    return (
      <>
        <output>{pr.threads[0]?.comments[0]?.body}</output>
        <DraftSyncNotice pr={pr} />
      </>
    );
  }
  const otherSlot = renderSlot(
    {
      component: () => (
        <PluginQueryBoundary>
          <Other />
        </PluginQueryBoundary>
      ),
    },
    {},
    { rpc: {} as never },
  );
  disposers.push(() => otherSlot.lifecycle.unmount());
  expect(otherSlot.getByText("Original")).toBeTruthy();
  write.reject(new Error("Account-specific failure"));
  await slot.findByText("GitHub did not save your draft");
  expect(otherSlot.container.textContent).not.toContain("GitHub did not save your draft");
});

test("hovering several inbox rows caps speculative reads at two", async () => {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const reads = deferred<PullRequest>();
  const slot = renderSlot(
    inboxTabRegistration(app),
    { subPath: "" },
    {
      rpc: {
        status: () => ({ ok: true, login: "scott", accounts: ["scott"] }),
        inbox: () => ({
          ...inbox,
          assigned: [1, 2, 3].map((number) =>
            Object.assign({}, inbox.assigned[0]!, {
              ref: { ...input.ref, number },
              title: `Review ${number}`,
            }),
          ),
        }),
        pullRequest: () => reads.promise,
        localBranches: () => ({ available: false, reason: "Fixture" }),
      } as never,
    },
  );
  disposers.push(() => slot.lifecycle.unmount());
  await slot.findByText("Review 1");
  for (const number of [1, 2, 3])
    fireEvent.mouseEnter(slot.getByRole("button", { name: new RegExp(`Review ${number}`) }));
  await waitFor(() =>
    expect(slot.rpcCalls.filter((call) => call.method === "pullRequest")).toHaveLength(2),
  );
  reads.resolve(pullRequest);
});

test("prefetch eviction retains the inbox and status needed for a cold reload", () => {
  const writer = localClient();
  const save = installLocalCache(writer, window.localStorage);
  writer.setQueryData(
    ["status"],
    { ok: true, login: "scott", accounts: ["scott"] },
    { updatedAt: Date.now() - 1000 },
  );
  writer.setQueryData(["inbox"], inbox, { updatedAt: Date.now() - 1000 });
  for (let number = 1; number <= 40; number++) {
    const ref = { ...input.ref, number };
    writer.setQueryData(rpc.pullRequest.queryKey({ ...input, ref }), { ...pullRequest, ref });
  }
  save();
  const reader = localClient();
  disposers.push(installLocalCache(reader, window.localStorage));
  expect(reader.getQueryData<Inbox>(["inbox"])).toEqual(inbox);
  expect(reader.getQueryData(["status"])).toMatchObject({ ok: true });
  expect(reader.getQueryCache().getAll().length).toBeLessThanOrEqual(32);
});

test("encoded account routes from the live BB router open the same PR", () => {
  expect(parsePrSubPath("%40scott/acme/api/pull/42/changes")).toEqual(
    parsePrSubPath("@scott/acme/api/pull/42/changes"),
  );
  expect(parsePrSubPath("%zz/acme/api/pull/42")).toBeNull();
  expect(parsePrSubPath("%40scott%2Fother/acme/api/pull/42")).toBeNull();
});

test("a seen PR restores synchronously from disk after memory cache eviction", async () => {
  const save = installLocalCache(pluginQueryClient, window.localStorage);
  pluginQueryClient.setQueryData(prKey, pullRequest);
  window.dispatchEvent(new window.Event("pagehide"));
  pluginQueryClient.removeQueries({ queryKey: prKey, exact: true });
  const pending = deferred<PullRequest>();
  function View() {
    const query = rpc.pullRequest.useQuery(input);
    return <output>{query.data?.title ?? "Loading"}</output>;
  }
  const slot = renderSlot(
    {
      component: () => (
        <PluginQueryBoundary>
          <View />
        </PluginQueryBoundary>
      ),
    },
    {},
    { rpc: { pullRequest: () => pending.promise } as never },
  );
  disposers.push(() => slot.lifecycle.unmount(), save);
  expect(slot.getByText(pullRequest.title)).toBeTruthy();
  expect(slot.queryByText("Loading")).toBeNull();
});

test("an acknowledged old save preserves newer unsent form text", async () => {
  const write = deferred<{
    threadId: string;
    commentId: string;
    pendingReview: { id: string; draftCount: number };
  }>();
  pluginQueryClient.setQueryData(prKey, pullRequest);
  function Form() {
    return (
      <PluginQueryBoundary>
        <NewCommentForm
          pr={pullRequest}
          path="src/a.ts"
          headRefOid={pullRequest.headRefOid}
          baseRefName={pullRequest.baseRefName}
          target={{ line: 1, side: "RIGHT", startLine: null, startSide: null }}
          onSaved={() => {}}
          onClose={() => {}}
        />
      </PluginQueryBoundary>
    );
  }
  const slot = renderSlot(
    { component: Form },
    {},
    { rpc: { addDraftComment: () => write.promise } as never },
  );
  fireEvent.change(slot.getByRole("textbox"), { target: { value: "First body" } });
  fireEvent.click(slot.getByRole("button", { name: "Add review comment" }));
  await waitFor(() =>
    expect(slot.rpcCalls.some((call) => call.method === "addDraftComment")).toBe(true),
  );
  const key = `new:scott:${pullRequest.id}:src/a.ts`;
  writeDraftText(key, "Newer unsent body");
  write.resolve({
    threadId: "T-old",
    commentId: "C-old",
    pendingReview: { id: "R1", draftCount: 1 },
  });
  await slot.findByText("Saved to your pending review.");
  expect(readDraftText(key)).toBe("Newer unsent body");
  slot.lifecycle.unmount();
});

test("out-of-order add acknowledgements cannot shrink the confirmed draft count", async () => {
  const first = deferred<{
    threadId: string;
    commentId: string;
    pendingReview: { id: string; draftCount: number };
  }>();
  const slot = draftSlot({
    addDraftComment: () => first.promise,
    pullRequest: () => new Promise<PullRequest>(() => {}),
  });
  fireEvent.click(slot.getByText("Add"));
  await waitFor(() => expect(slot.getByTestId("comments").textContent).toContain("New draft"));
  // Another client can acknowledge its own addition while this request is out.
  act(() =>
    pluginQueryClient.setQueryData(prKey, {
      ...withDraft,
      pendingReview: { id: "R1", body: "", draftCount: 2 },
      threads: [
        thread,
        {
          ...thread,
          id: "T-other",
          comments: [{ ...thread.comments[0]!, id: "C-other", body: "Other draft" }],
        },
      ],
    }),
  );
  first.resolve({
    threadId: "T-first",
    commentId: "C-first",
    pendingReview: { id: "R1", draftCount: 1 },
  });
  await waitFor(() => expect(pluginQueryClient.isMutating()).toBe(0));
  expect(
    pluginQueryClient.getQueryData<PullRequest>(prKey)?.pendingReview?.draftCount,
  ).toBeGreaterThanOrEqual(3);
});

function SummaryField() {
  const [text, setText] = useDraftText("review:scott:existing", "Server summary");
  return <textarea aria-label="Summary" value={text} onChange={(e) => setText(e.target.value)} />;
}

test("clearing a prefilled review remains empty after reload instead of reviving the server text", () => {
  const first = renderSlot({ component: SummaryField }, {}, {});
  const box = first.getByRole("textbox", { name: "Summary" }) as HTMLTextAreaElement;
  expect(box.value).toBe("Server summary");
  fireEvent.change(box, { target: { value: "" } });
  first.lifecycle.unmount();

  const again = renderSlot({ component: SummaryField }, {}, {});
  expect((again.getByRole("textbox", { name: "Summary" }) as HTMLTextAreaElement).value).toBe("");
  again.lifecycle.unmount();
});

test("text that storage refused to keep reopens with the newest words, not the older saved ones", () => {
  const key = "edit:scott:C1";
  writeDraftText(key, "Older words");
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = () => {
    throw new DOMException("Full", "QuotaExceededError");
  };
  try {
    writeDraftText(key, "Newest words");
  } finally {
    Storage.prototype.setItem = setItem;
  }
  expect(readDraftText(key)).toBe("Newest words");
  writeDraftText(key, "Saved again");
  expect(window.localStorage.getItem(`code-review:text:v1:${key}`)).toBe("Saved again");
  expect(readDraftText(key)).toBe("Saved again");
});

test("a read that lands after gh signs out of its account is not kept", async () => {
  const workInput = { ...input, account: "work" };
  const client = localClient();
  const stop = installLocalCache(client, window.localStorage);
  client.setQueryData(["status"], { ok: true, login: "scott", accounts: ["scott"] });
  // A PR read started as "work" before the sign-out answers afterwards.
  client.setQueryData(rpc.pullRequest.queryKey(workInput), { ...pullRequest, account: "work" });
  stop();
  const after = localClient();
  disposers.push(installLocalCache(after, window.localStorage));
  expect(after.getQueryData(rpc.pullRequest.queryKey(workInput))).toBeUndefined();
});

test("unsent text typed as a signed-out account is forgotten with its reads", () => {
  writeDraftText("edit:work:C1", "Work words");
  writeDraftText("edit:scott:C1", "Scott words");
  const client = localClient();
  const stop = installLocalCache(client, window.localStorage);
  client.setQueryData(["status"], { ok: true, login: "scott", accounts: ["scott"] });
  stop();
  expect(readDraftText("edit:work:C1")).toBe("");
  expect(readDraftText("edit:scott:C1")).toBe("Scott words");
});

test("a hover prefetch is kept only once a panel shows it", async () => {
  const client = localClient();
  const stop = installLocalCache(client, window.localStorage);
  await client.prefetchQuery({ queryKey: prKey, queryFn: () => pullRequest });
  stop();
  const restored = localClient();
  disposers.push(installLocalCache(restored, window.localStorage));
  expect(restored.getQueryData(prKey)).toBeUndefined();
});

test("a first reply's save names GitHub's pending review even when the PR cannot be read again", async () => {
  const write = deferred<{
    commentId: string;
    pendingReview: { id: string; draftCount: number };
  }>();
  const posted = { ...thread, comments: [{ ...thread.comments[0]!, isDraft: false }] };
  const slot = draftSlot({
    replyDraft: () => write.promise,
    pullRequest: () => {
      throw new Error("Offline");
    },
  });
  act(() =>
    pluginQueryClient.setQueryData(prKey, { ...withDraft, pendingReview: null, threads: [posted] }),
  );
  fireEvent.click(slot.getByText("Reply"));
  write.resolve({ commentId: "C-reply", pendingReview: { id: "PRR_real", draftCount: 1 } });
  await waitFor(() =>
    expect(pluginQueryClient.getQueryData<PullRequest>(prKey)?.pendingReview?.id).toBe("PRR_real"),
  );
});
