import "../../test/dom.ts";
import { beforeEach, expect, test } from "bun:test";
import type { ComponentType } from "react";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { pullRequest } from "../../test/app-fixtures.ts";
import { AGENT_ACTIVITY_CHANNEL } from "../shared/schema.ts";
import type {
  AgentActivity,
  Check,
  Checks,
  Finding,
  LinkedThread,
  PullRequest,
  ReviewThread,
} from "../shared/schema.ts";

const { fireEvent, waitFor, within } = await import("@testing-library/react");
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { PluginQueryBoundary } = await import("@bb-kit/core/rpc/query");
const { ChecksList } = await import("./checks.tsx");
const { FindingsCard, LinkedThreads, ReviewWithBbButton } = await import("./bb-review.tsx");
const { FindingCard } = await import("./finding.tsx");
const { SubmitReviewButton } = await import("./submit-review.tsx");
const { rpc: pluginRpc } = await import("./rpc.ts");

beforeEach(() => pluginQueryClient.clear());

type Handlers = Record<string, (input: never) => unknown>;

/** Mounts one of the pull request's parts the way the page does: inside the plugin's query cache. */
function mount(Part: ComponentType<{ pr: PullRequest }>, rpc: Handlers) {
  const Bounded = (props: { pr: PullRequest }) => (
    <PluginQueryBoundary>
      <Part {...props} />
    </PluginQueryBoundary>
  );
  return renderSlot({ component: Bounded }, { pr }, { rpc: rpc as never });
}

/**
 * A part as the page renders it: with the pull request as last read, so a
 * new read of it (a push, a discarded draft) reaches the part.
 */
function live(Part: ComponentType<{ pr: PullRequest }>, options: { staleTime?: number } = {}) {
  return function Live({ pr: first }: { pr: PullRequest }) {
    const read = pluginRpc.pullRequest.useQuery(
      { account: first.account, ref: first.ref },
      options,
    );
    return read.data ? <Part pr={read.data} /> : null;
  };
}

/**
 * Waits until `query` finds nothing. `expect(element).toBeNull()` would print
 * the whole jsdom window, megabytes of it, on every miss, and stall the
 * render being waited for past the timeout.
 */
function gone(query: () => HTMLElement | null) {
  return waitFor(() => {
    if (query()) throw new Error("Still on screen");
  });
}

function readPullRequestAgain() {
  return pluginQueryClient.invalidateQueries({
    queryKey: pluginRpc.pullRequest.queryKey({
      account: pullRequest.account,
      ref: pullRequest.ref,
    }),
  });
}

const pr: PullRequest = pullRequest;
const HEAD = pr.headRefOid;
const BASE = pr.baseRefName;
const OLD_HEAD = "9999999999999999999999999999999999999999";

function check(id: string, name: string, state: Check["state"], extra: Partial<Check> = {}): Check {
  return {
    id,
    name,
    workflow: "CI",
    state,
    description: null,
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    jobId: null,
    ...extra,
  };
}

const checks: Checks = {
  headRefOid: HEAD,
  state: "failure",
  checks: [
    check("run:1", "test", "failure", {
      description: "Process completed with exit code 1.",
      detailsUrl: "https://github.com/acme/api/actions/runs/1/job/1",
      startedAt: "2026-10-09T10:00:00Z",
      completedAt: "2026-10-09T10:02:05Z",
      jobId: 1,
    }),
    check("run:2", "typecheck", "failure", { jobId: 2 }),
    check("run:3", "e2e", "pending"),
    check("run:4", "lint", "success"),
    check("run:5", "deploy-preview", "skipped"),
  ],
};

function finding(id: string, extra: Partial<Finding> = {}): Finding {
  return {
    id,
    priority: 2,
    title: "Bucket never refills",
    body: "`refill()` is never scheduled.",
    path: "src/limit.ts",
    line: 18,
    startLine: null,
    side: "RIGHT",
    ...extra,
  };
}

function linked(threadId: string, extra: Partial<LinkedThread> = {}): LinkedThread {
  return {
    threadId,
    kind: "review",
    title: `Review acme/api#42`,
    status: "idle",
    createdAt: "2026-10-09T10:00:00Z",
    headRefOid: HEAD,
    baseRefName: BASE,
    ...extra,
  };
}

const noActivity: AgentActivity = { threads: [], latestReview: null };

function reviewed(findings: Finding[], headRefOid = HEAD, baseRefName = BASE): AgentActivity {
  return {
    threads: [linked("thread-review", { headRefOid, baseRefName })],
    latestReview: {
      threadId: "thread-review",
      headRefOid,
      baseRefName,
      reportedAt: "2026-10-09T10:30:00Z",
      summary: "One real bug in the limiter.",
      findings,
    },
  };
}

// ── Checks ───────────────────────────────────────────────────────────────

test("checks are grouped worst first, and skipped ones stay folded away", async () => {
  const slot = mount(ChecksList, { checks: () => checks });
  await slot.findByText("test");

  const sections = slot.getAllByRole("region").map((section) => section.getAttribute("aria-label"));
  expect(sections).toEqual(["Failing", "In progress", "Passed", "Skipped, neutral, or cancelled"]);
  const failing = within(slot.getByRole("region", { name: "Failing" }));
  expect(failing.getByText("CI · Process completed with exit code 1.")).toBeTruthy();
  expect(failing.getByText("2m 05s")).toBeTruthy();
  expect(failing.getByRole("link", { name: "Details for test" }).getAttribute("href")).toBe(
    "https://github.com/acme/api/actions/runs/1/job/1",
  );
  expect(slot.queryByText("deploy-preview")).toBeNull();

  fireEvent.click(slot.getByRole("button", { name: /Skipped, neutral, or cancelled/ }));
  expect(slot.getByText("deploy-preview")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a commit with no checks says so", async () => {
  const slot = mount(ChecksList, { checks: () => ({ headRefOid: HEAD, state: null, checks: [] }) });
  expect(await slot.findByText("No checks reported for this commit")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a background poll leaves the checks where they are: the page header reports syncing", async () => {
  let release!: () => void;
  let slow = false;
  const slot = mount(ChecksList, {
    checks: () =>
      slow
        ? new Promise((resolve) => {
            release = () => resolve(checks);
          })
        : checks,
  });
  await slot.findByText("test");
  slow = true;
  const poll = pluginQueryClient.refetchQueries();
  await waitFor(() => expect(release).toBeDefined());
  expect(slot.queryByText("Syncing with GitHub…")).toBeNull();
  release();
  await poll;
  slot.lifecycle.unmount();
});

test("a failed background read keeps the checks and the selection, and says so", async () => {
  let failing = false;
  const slot = mount(ChecksList, {
    checks: () => {
      if (failing) throw new Error("API rate limit exceeded");
      return checks;
    },
  });
  await slot.findByText("test");
  fireEvent.click(slot.getByRole("checkbox", { name: "Include test in the fix" }));

  failing = true;
  await pluginQueryClient.refetchQueries();
  expect(await slot.findByText(/^Could not load the latest checks: /)).toBeTruthy();
  expect(slot.getByText("test")).toBeTruthy();
  const boxes = slot.getAllByRole("checkbox") as HTMLInputElement[];
  expect(boxes.map((box) => box.checked)).toEqual([false, true]);
  slot.lifecycle.unmount();
});

test("checks are read again as soon as the pull request moves to a new head", async () => {
  let head = OLD_HEAD;
  const before: Checks = {
    headRefOid: OLD_HEAD,
    state: "success",
    checks: [check("run:9", "build-before-push", "success")],
  };
  const slot = mount(live(ChecksList), {
    pullRequest: () => ({ ...pr, headRefOid: head }),
    checks: () => (head === OLD_HEAD ? before : checks),
  });
  await slot.findByText("build-before-push");

  head = HEAD;
  await readPullRequestAgain();
  // Settled checks poll every two minutes. The push is caught well before that.
  expect(await slot.findByText("typecheck")).toBeTruthy();
  expect(slot.queryByText("build-before-push")).toBeNull();
  slot.lifecycle.unmount();
});

test("Fix opens a composer seeded with the prompt for the selected failures", async () => {
  const rpc: Handlers = {
    checks: () => checks,
    fixChecksPrompt: () => ({
      prompt: "Fix `typecheck` on acme/api#42.",
      projectId: "project-api",
    }),
    startFix: () => ({ threadId: "thread-fix" }),
    agentActivity: () => noActivity,
  };
  const slot = mount(ChecksList, rpc);
  await slot.findByText("test");

  const boxes = slot.getAllByRole("checkbox") as HTMLInputElement[];
  expect(boxes.map((box) => [box.getAttribute("aria-label"), box.checked])).toEqual([
    ["Include test in the fix", true],
    ["Include typecheck in the fix", true],
  ]);
  expect(slot.getByRole("button", { name: "Fix 2 checks" })).toBeTruthy();
  fireEvent.click(boxes[0]!);
  fireEvent.click(slot.getByRole("button", { name: "Fix" }));

  const composer = await slot.findByTestId("bb-new-thread-composer");
  expect(slot.rpcCalls.find((call) => call.method === "fixChecksPrompt")?.input).toEqual({
    account: "scott",
    ref: { owner: "acme", repo: "api", number: 42 },
    checkIds: ["run:2"],
  });
  // No provider is pinned, so the composer opens on bb's default agent.
  expect(composer.dataset.defaultProviderId).toBe("");
  expect(composer.dataset.defaultProjectId).toBe("project-api");
  expect(composer.dataset.layout).toBe("contained");
  expect(composer.dataset.draftKey).toBe(`code-review-fix:acme/api#42@${HEAD}:run:2`);
  expect((slot.getByTestId("bb-new-thread-composer-input") as HTMLTextAreaElement).value).toBe(
    "Fix `typecheck` on acme/api#42.",
  );

  fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
  await waitFor(() =>
    expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId: "thread-fix" }]),
  );
  const start = slot.rpcCalls.find((call) => call.method === "startFix")?.input as {
    ref: unknown;
    headRefOid: string;
    request: { projectId: string; providerId: string };
  };
  expect(start.ref).toEqual({ owner: "acme", repo: "api", number: 42 });
  expect(start.headRefOid).toBe(HEAD);
  // The test composer submits "codex" when no provider is pinned.
  expect([start.request.projectId, start.request.providerId]).toEqual(["project-api", "codex"]);
  await gone(() => slot.queryByTestId("bb-new-thread-composer"));
  slot.lifecycle.unmount();
});

test("a prompt that cannot be built says why and can be asked for again", async () => {
  let attempts = 0;
  const rpc: Handlers = {
    checks: () => checks,
    fixChecksPrompt: () => {
      attempts += 1;
      throw new Error("Those checks are no longer on the latest commit. Refresh and try again.");
    },
  };
  const slot = mount(ChecksList, rpc);
  await slot.findByText("test");
  fireEvent.click(slot.getByRole("button", { name: "Fix 2 checks" }));

  expect(await slot.findByText("Could not prepare the fix", {}, { timeout: 5000 })).toBeTruthy();
  expect(
    slot.getByText("Those checks are no longer on the latest commit. Refresh and try again."),
  ).toBeTruthy();
  const before = attempts;
  fireEvent.click(slot.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(attempts).toBeGreaterThan(before));
  slot.lifecycle.unmount();
});

// ── Review with bb ────────────────────────────────────────────────────

test("Review with bb starts one review, then opens it instead of starting another", async () => {
  let activity = noActivity;
  const rpc: Handlers = {
    agentActivity: () => activity,
    startReview: () => {
      activity = { threads: [linked("thread-review", { status: "active" })], latestReview: null };
      return { threadId: "thread-review" };
    },
  };
  const slot = mount(ReviewWithBbButton, rpc);

  fireEvent.click(await slot.findByRole("button", { name: "Review with bb" }));
  const reviewing = await slot.findByRole("button", { name: "Reviewing…" });
  expect(slot.rpcCalls.filter((call) => call.method === "startReview")).toEqual([
    {
      method: "startReview",
      input: { account: "scott", ref: { owner: "acme", repo: "api", number: 42 } },
    },
  ]);

  fireEvent.click(reviewing);
  expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId: "thread-review" }]);
  expect(slot.rpcCalls.filter((call) => call.method === "startReview")).toHaveLength(1);
  slot.lifecycle.unmount();
});

/**
 * The review button once `thread` is on screen: the thread list beside it
 * reads the same activity, so its row shows the button has it too.
 */
async function reviewButtonBeside(thread: LinkedThread) {
  const activity: AgentActivity = { threads: [thread], latestReview: null };
  const Both = ({ pr }: { pr: PullRequest }) => (
    <>
      <ReviewWithBbButton pr={pr} />
      <LinkedThreads pr={pr} />
    </>
  );
  const slot = mount(Both, { agentActivity: () => activity });
  await slot.findByRole("button", { name: /^Review acme\/api#42: Review thread, working/ });
  return slot;
}

test("a review running on an older head does not block reviewing the new one", async () => {
  const slot = await reviewButtonBeside(
    linked("thread-old", { status: "active", headRefOid: OLD_HEAD }),
  );
  expect(slot.getByRole("button", { name: "Review with bb" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a review running against the old base does not block reviewing after a retarget", async () => {
  const slot = await reviewButtonBeside(
    linked("thread-old", { status: "active", baseRefName: "release" }),
  );
  expect(slot.getByRole("button", { name: "Review with bb" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a review running on this head and base is the one the button opens", async () => {
  const slot = await reviewButtonBeside(linked("thread-now", { status: "active" }));
  expect(slot.getByRole("button", { name: "Reviewing…" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("the gear edits the standing review instructions", async () => {
  const rpc: Handlers = {
    agentActivity: () => noActivity,
    reviewInstructions: () => ({ instructions: "Flag missing tests." }),
    setReviewInstructions: (input: { instructions: string }) => input,
  };
  const slot = mount(ReviewWithBbButton, rpc);
  fireEvent.click(await slot.findByRole("button", { name: "bb review instructions" }));

  const field = (await slot.findByRole("textbox", {
    name: "Review instructions",
  })) as HTMLTextAreaElement;
  expect(field.value).toBe("Flag missing tests.");
  expect(slot.getByText("Standing criteria and report format for every bb review")).toBeTruthy();
  expect((slot.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(field, { target: { value: "Flag missing tests.\nIgnore style." } });
  fireEvent.click(slot.getByRole("button", { name: "Save" }));
  await gone(() => slot.queryByRole("textbox", { name: "Review instructions" }));
  expect(slot.rpcCalls.find((call) => call.method === "setReviewInstructions")?.input).toEqual({
    instructions: "Flag missing tests.\nIgnore style.",
  });
  slot.lifecycle.unmount();
});

test("activity for this pull request is read again when the server says it changed", async () => {
  const slot = mount(ReviewWithBbButton, { agentActivity: () => noActivity });
  await waitFor(() => expect(slot.rpcCalls).toHaveLength(1));

  await slot.emitRealtime(AGENT_ACTIVITY_CHANNEL, { key: "acme/other#42" });
  await slot.emitRealtime(AGENT_ACTIVITY_CHANNEL, { key: "acme/api#42" });
  await waitFor(() => expect(slot.rpcCalls).toHaveLength(2));
  // GitHub names are case-insensitive, and a thread started from a link typed
  // in another case still belongs to this pull request.
  await slot.emitRealtime(AGENT_ACTIVITY_CHANNEL, { key: "Acme/API#42" });
  await waitFor(() => expect(slot.rpcCalls).toHaveLength(3));
  slot.lifecycle.unmount();
});

// ── Findings and linked threads ──────────────────────────────────────────

/** Every draft write the slots sent, mounted again or not. */
function draftWrites(...slots: { rpcCalls: { method: string; input: unknown }[] }[]) {
  return slots.flatMap((slot) => slot.rpcCalls).filter((call) => call.method === "addDraftComment");
}

/** The pull request reads once. Every read after that stays out. */
function readOnce(first: PullRequest = pr): () => unknown {
  let reads = 0;
  return () => (++reads === 1 ? first : new Promise(() => {}));
}

/** The server's answer to a draft written into the fixture's pending review. */
function savedDraft(threadId: string, commentId: string, draftCount = 3) {
  return { threadId, commentId, pendingReview: { id: "PRR_pending", draftCount } };
}

test("findings read most urgent first and reveal their line in Changes", async () => {
  const activity = reviewed([
    finding("f1", { priority: 2, title: "Magic number" }),
    finding("f2", { priority: 0, title: "Bucket never refills", startLine: 16 }),
  ]);
  const revealed: unknown[] = [];
  const listener = (event: Event) => revealed.push((event as CustomEvent).detail);
  window.addEventListener("code-review:reveal", listener);
  const slot = mount(FindingsCard, { agentActivity: () => activity });

  await slot.findByText("One real bug in the limiter.");
  const titles = slot.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
  expect(titles).toEqual(["Bucket never refills", "Magic number"]);
  expect(slot.getByText("src/limit.ts:16-18")).toBeTruthy();
  expect(slot.queryByText("Stale")).toBeNull();

  fireEvent.click(slot.getAllByRole("button", { name: "Show in Changes" })[0]!);
  expect(slot.navigateCalls).toEqual([
    {
      method: "toPluginPanel",
      path: "code-review",
      options: { subPath: "@scott/acme/api/pull/42/changes" },
    },
  ]);
  await waitFor(() =>
    expect(revealed).toEqual([{ path: "src/limit.ts", line: 18, side: "RIGHT" }]),
  );
  window.removeEventListener("code-review:reveal", listener);
  slot.lifecycle.unmount();
});

test("a finding becomes a draft comment in the pending review", async () => {
  const rpc: Handlers = {
    agentActivity: () => reviewed([finding("f1", { priority: 1, startLine: 16 })]),
    addDraftComment: () => savedDraft("PRRT_1", "PRRC_1"),
    // The read after saving stays out, so what shows the draft is the save.
    pullRequest: readOnce({
      ...pr,
      pendingReview: { id: "PRR_pending", body: "Nearly there.", draftCount: 2 },
    }),
  };
  const slot = mount(live(FindingsCard), rpc);
  fireEvent.click(await slot.findByRole("button", { name: "Add as draft comment" }));

  expect(await slot.findByText("In your pending review")).toBeTruthy();
  expect(slot.rpcCalls.find((call) => call.method === "addDraftComment")?.input).toEqual({
    account: "scott",
    pullRequestId: "PR_kwDOA42",
    headRefOid: HEAD,
    baseRefName: "main",
    path: "src/limit.ts",
    body: "**[P1] Bucket never refills**\n\n`refill()` is never scheduled.",
    line: 18,
    startLine: 16,
    side: "RIGHT",
    startSide: "RIGHT",
  });
  // The summary typed so far stays, and the count is the server's.
  const cached = pluginQueryClient.getQueryData<PullRequest>(
    pluginRpc.pullRequest.queryKey({ account: pr.account, ref: pr.ref }),
  );
  expect(cached?.pendingReview).toEqual({
    id: "PRR_pending",
    body: "Nearly there.",
    draftCount: 3,
  });
  slot.lifecycle.unmount();
});

/** The viewer's draft of a single-line finding, as GitHub lists it. */
function draftOf(target: Finding): ReviewThread {
  return {
    id: `PRRT_${target.id}`,
    path: target.path,
    line: target.line,
    startLine: null,
    startSide: null,
    side: "RIGHT",
    originalLine: target.line,
    isResolved: false,
    isOutdated: false,
    isFileLevel: false,
    diffHunk: "",
    comments: [
      {
        id: `PRRC_${target.id}`,
        author: null,
        body: "**[P2] Bucket never refills**\n\n`refill()` is never scheduled.",
        createdAt: "2026-10-09T10:40:00Z",
        url: "",
        isDraft: true,
      },
    ],
  };
}

test("a finding can be drafted again once its draft leaves the pending review", async () => {
  const target = finding("f1");
  const withDraft: PullRequest = { ...pr, threads: [draftOf(target)] };
  let current = pr;
  const slot = mount(live(FindingsCard), {
    agentActivity: () => reviewed([target]),
    pullRequest: () => current,
    addDraftComment: () => {
      current = withDraft;
      return savedDraft("PRRT_1", "PRRC_1");
    },
  });
  fireEvent.click(await slot.findByRole("button", { name: "Add as draft comment" }));
  expect(await slot.findByText("In your pending review")).toBeTruthy();
  // The read after adding it lands, with the draft in it.
  await pluginQueryClient.refetchQueries(
    { queryKey: pluginRpc.pullRequest.queryKey({ account: pr.account, ref: pr.ref }) },
    { cancelRefetch: false },
  );
  expect(slot.getByText("In your pending review")).toBeTruthy();

  // The drafts are discarded, or the review submitted.
  current = pr;
  await readPullRequestAgain();
  const again = (await slot.findByRole("button", {
    name: "Add as draft comment",
  })) as HTMLButtonElement;
  expect(again.disabled).toBe(false);
  expect(slot.queryByText("In your pending review")).toBeNull();
  slot.lifecycle.unmount();
});

test("a finding is added again once the review is submitted before its draft was ever read", async () => {
  const target = finding("f1");
  let reads = 0;
  let land = () => {};
  const slot = mount(live(FindingsCard), {
    agentActivity: () => reviewed([target]),
    // The review is submitted between saving the draft and the read after
    // it, so no read ever shows the draft.
    pullRequest: () => {
      reads += 1;
      if (reads === 1) return pr;
      return new Promise((resolve) => {
        land = () => resolve(pr);
      });
    },
    addDraftComment: () => savedDraft("PRRT_1", "PRRC_1"),
  });
  fireEvent.click(await slot.findByRole("button", { name: "Add as draft comment" }));
  expect(await slot.findByText("In your pending review")).toBeTruthy();
  await waitFor(() => expect(reads).toBe(2));

  land();
  const again = (await slot.findByRole("button", {
    name: "Add as draft comment",
  })) as HTMLButtonElement;
  expect(again.disabled).toBe(false);
  expect(slot.queryByText("In your pending review")).toBeNull();
  slot.lifecycle.unmount();
});

test("a finding being saved is sent once, also clicked again or mounted again before it shows", async () => {
  let answer = () => {};
  const rpc: Handlers = {
    agentActivity: () => reviewed([finding("f1")]),
    pullRequest: readOnce(),
    addDraftComment: () =>
      new Promise((resolve) => {
        answer = () => resolve(savedDraft("PRRT_1", "PRRC_1"));
      }),
  };
  const first = mount(live(FindingsCard), rpc);
  const add = await first.findByRole("button", { name: "Add as draft comment" });
  // The second click lands before the render that disables the button.
  fireEvent.click(add);
  fireEvent.click(add);
  first.lifecycle.unmount();

  // The viewer leaves the tab and comes back while the write is out.
  const again = mount(live(FindingsCard), rpc);
  const busy = (await again.findByRole("button", {
    name: "Add as draft comment",
  })) as HTMLButtonElement;
  expect(busy.disabled).toBe(true);
  expect(busy.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(busy);

  answer();
  expect(await again.findByText("In your pending review")).toBeTruthy();
  expect(draftWrites(first, again)).toHaveLength(1);
  again.lifecycle.unmount();
});

test("a saved finding stays in the pending review on a card mounted again before the next read", async () => {
  const rpc: Handlers = {
    agentActivity: () => reviewed([finding("f1")]),
    pullRequest: readOnce(),
    addDraftComment: () => savedDraft("PRRT_1", "PRRC_1"),
  };
  const first = mount(live(FindingsCard), rpc);
  fireEvent.click(await first.findByRole("button", { name: "Add as draft comment" }));
  expect(await first.findByText("In your pending review")).toBeTruthy();
  first.lifecycle.unmount();

  const again = mount(live(FindingsCard), rpc);
  expect(await again.findByText("In your pending review")).toBeTruthy();
  expect(again.queryByRole("button", { name: "Add as draft comment" })).toBeNull();
  expect(draftWrites(first, again)).toHaveLength(1);
  again.lifecycle.unmount();
});

/** How the page reads the pull request: a read under 15 seconds old is shown as it is. */
const PAGE_READ = { staleTime: 15_000 };

test("a finding saved while an older read is out still shows saved when the viewer comes back", async () => {
  const target = finding("f1");
  const drafted: PullRequest = {
    ...pr,
    threads: [draftOf(target)],
    pendingReview: { id: "PRR_pending", body: "", draftCount: 3 },
  };
  let written = false;
  let reads = 0;
  let landOlder = () => {};
  let answer = () => {};
  const rpc: Handlers = {
    agentActivity: () => reviewed([target]),
    pullRequest: () => {
      reads += 1;
      // The second read leaves before the draft is written and lands after it.
      if (reads === 2) {
        return new Promise((resolve) => {
          landOlder = () => resolve(pr);
        });
      }
      return written ? drafted : pr;
    },
    addDraftComment: () =>
      new Promise((resolve) => {
        answer = () => {
          written = true;
          resolve(savedDraft("PRRT_f1", "PRRC_f1"));
        };
      }),
  };
  const first = mount(live(FindingsCard, PAGE_READ), rpc);
  const add = await first.findByRole("button", { name: "Add as draft comment" });
  void readPullRequestAgain();
  await waitFor(() => expect(reads).toBe(2));
  fireEvent.click(add);
  await waitFor(() => expect(draftWrites(first)).toHaveLength(1));

  // The viewer leaves before GitHub answers, and the older read lands last.
  first.lifecycle.unmount();
  answer();
  await waitFor(() => expect(pluginQueryClient.isMutating()).toBe(0));
  landOlder();
  await waitFor(() => expect(pluginQueryClient.isFetching()).toBe(0));

  const again = mount(live(FindingsCard, PAGE_READ), rpc);
  expect(await again.findByText("In your pending review")).toBeTruthy();
  expect(again.queryByRole("button", { name: "Add as draft comment" })).toBeNull();
  expect(draftWrites(first, again)).toHaveLength(1);
  again.lifecycle.unmount();
});

test("the first draft starts a pending review that can be submitted or discarded at once", async () => {
  const WithSubmit = ({ pr }: { pr: PullRequest }) => (
    <>
      <FindingsCard pr={pr} />
      <SubmitReviewButton pr={pr} />
    </>
  );
  const slot = mount(live(WithSubmit), {
    agentActivity: () => reviewed([finding("f1")]),
    // No pending review yet, and the read after saving stays out.
    pullRequest: readOnce({ ...pr, pendingReview: null }),
    addDraftComment: () => ({
      threadId: "PRRT_1",
      commentId: "PRRC_1",
      pendingReview: { id: "PRR_new", draftCount: 1 },
    }),
  });
  fireEvent.click(await slot.findByRole("button", { name: "Add as draft comment" }));
  expect(await slot.findByText("In your pending review")).toBeTruthy();
  const cached = pluginQueryClient.getQueryData<PullRequest>(
    pluginRpc.pullRequest.queryKey({ account: pr.account, ref: pr.ref }),
  );
  expect(cached?.pendingReview).toEqual({ id: "PRR_new", body: "", draftCount: 1 });

  fireEvent.click(slot.getByRole("button", { name: "Submit review (1 draft comment)" }));
  const dialog = within(await slot.findByRole("dialog", { name: "Submit review" }));
  const submit = dialog.getByRole("button", { name: "Submit review" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
  expect(dialog.getByRole("button", { name: "Discard drafts" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a finding being saved is sent once also from the pull request opened under another casing", async () => {
  const target = finding("f1");
  let answer = () => {};
  // GitHub names are case-insensitive, so one pull request opens under either link.
  const Both = ({ pr }: { pr: PullRequest }) => (
    <>
      <FindingCard finding={target} stale={false} pr={pr} />
      <FindingCard
        finding={target}
        stale={false}
        pr={{ ...pr, ref: { owner: "Acme", repo: "API", number: 42 } }}
      />
    </>
  );
  const slot = mount(Both, {
    addDraftComment: () =>
      new Promise((resolve) => {
        answer = () => resolve(savedDraft("PRRT_1", "PRRC_1"));
      }),
  });
  const [lower, upper] = slot.getAllByRole("button", {
    name: "Add as draft comment",
  }) as HTMLButtonElement[];
  // The second click lands before the render that disables the button.
  fireEvent.click(lower!);
  fireEvent.click(upper!);
  await waitFor(() => expect(upper!.getAttribute("aria-busy")).toBe("true"));

  answer();
  await waitFor(() => expect(pluginQueryClient.isMutating()).toBe(0));
  expect(draftWrites(slot)).toHaveLength(1);
  slot.lifecycle.unmount();
});

test("two identically worded findings at different lines are saved separately", async () => {
  const answers: (() => void)[] = [];
  const slot = mount(live(FindingsCard), {
    agentActivity: () => reviewed([finding("f1", { line: 4 }), finding("f2", { line: 80 })]),
    pullRequest: readOnce(),
    addDraftComment: ({ line }: { line: number }) =>
      new Promise((resolve) => {
        answers.push(() => resolve(savedDraft(`PRRT_${line}`, `PRRC_${line}`)));
      }),
  });
  await slot.findByText("src/limit.ts:4");
  const card = (location: string) => within(slot.getByText(location).closest("article")!);
  const add = (location: string) =>
    card(location).getByRole("button", { name: "Add as draft comment" }) as HTMLButtonElement;

  // Both clicks land before either card renders as saving.
  fireEvent.click(add("src/limit.ts:4"));
  fireEvent.click(add("src/limit.ts:80"));
  await waitFor(() => expect(answers).toHaveLength(2));
  answers[0]!();
  expect(await card("src/limit.ts:4").findByText("In your pending review")).toBeTruthy();
  expect(add("src/limit.ts:80").getAttribute("aria-busy")).toBe("true");

  answers[1]!();
  expect(await card("src/limit.ts:80").findByText("In your pending review")).toBeTruthy();
  expect(draftWrites(slot).map((call) => (call.input as { line: number }).line)).toEqual([4, 80]);
  slot.lifecycle.unmount();
});

test("two identically worded findings at different lines are tracked separately", async () => {
  const atFour = finding("f1", { line: 4 });
  const atEighty = finding("f2", { line: 80 });
  const Drafted = () => <FindingsCard pr={{ ...pr, threads: [draftOf(atFour)] }} />;
  const slot = mount(Drafted, { agentActivity: () => reviewed([atFour, atEighty]) });
  await slot.findByText("src/limit.ts:4");

  const card = (location: string) => within(slot.getByText(location).closest("article")!);
  expect(card("src/limit.ts:4").getByText("In your pending review")).toBeTruthy();
  expect(card("src/limit.ts:80").queryByText("In your pending review")).toBeNull();
  const add = card("src/limit.ts:80").getByRole("button", { name: "Add as draft comment" });
  expect((add as HTMLButtonElement).disabled).toBe(false);
  slot.lifecycle.unmount();
});

test("a finding whose review ran on an older head cannot be drafted, and says why", async () => {
  // The diff on screen can still be the reviewed one while the pull request has moved on.
  const Older = ({ pr }: { pr: PullRequest }) => (
    <FindingCard
      finding={finding("f1")}
      stale={false}
      reviewed={{ headRefOid: OLD_HEAD, baseRefName: BASE }}
      pr={pr}
    />
  );
  const slot = mount(Older, { addDraftComment: () => savedDraft("t", "c") });
  const draft = slot.getByRole("button", { name: "Add as draft comment" }) as HTMLButtonElement;
  expect(draft.disabled).toBe(true);
  expect(draft.parentElement?.getAttribute("title")).toBe(
    "bb reviewed an older version of this diff, so this line may not match it.",
  );
  fireEvent.click(draft);
  expect(slot.rpcCalls).toEqual([]);
  slot.lifecycle.unmount();
});

test("a finding whose review ran against another base cannot be drafted", async () => {
  // A retarget changes the base side's lines without a new head.
  const Retargeted = ({ pr }: { pr: PullRequest }) => (
    <FindingCard
      finding={finding("f1", { side: "LEFT" })}
      stale={false}
      reviewed={{ headRefOid: HEAD, baseRefName: "release" }}
      pr={pr}
    />
  );
  const slot = mount(Retargeted, { addDraftComment: () => savedDraft("t", "c") });
  const draft = slot.getByRole("button", { name: "Add as draft comment" }) as HTMLButtonElement;
  expect(draft.disabled).toBe(true);
  fireEvent.click(draft);
  expect(slot.rpcCalls).toEqual([]);
  slot.lifecycle.unmount();
});

test("a review of an older head is marked stale and its findings cannot be drafted", async () => {
  const slot = mount(FindingsCard, { agentActivity: () => reviewed([finding("f1")], OLD_HEAD) });
  expect(await slot.findByText("Stale")).toBeTruthy();
  expect(slot.getByText("9999999")).toBeTruthy();
  const draft = slot.getByRole("button", { name: "Add as draft comment" }) as HTMLButtonElement;
  expect(draft.disabled).toBe(true);
  slot.lifecycle.unmount();
});

test("a review against another base is marked stale and its findings cannot be drafted", async () => {
  const slot = mount(FindingsCard, {
    agentActivity: () => reviewed([finding("f1")], HEAD, "release"),
  });
  const stale = await slot.findByText("Stale");
  expect(stale.getAttribute("title")).toBe(
    "bb reviewed the changes against release. The pull request now targets main.",
  );
  const draft = slot.getByRole("button", { name: "Add as draft comment" }) as HTMLButtonElement;
  expect(draft.disabled).toBe(true);
  slot.lifecycle.unmount();
});

test("a clean review says so, and no review shows nothing", async () => {
  const clean = mount(FindingsCard, { agentActivity: () => reviewed([]) });
  expect(await clean.findByText("No findings.")).toBeTruthy();
  clean.lifecycle.unmount();
  pluginQueryClient.clear();

  const none = mount(FindingsCard, { agentActivity: () => noActivity });
  await waitFor(() => expect(none.rpcCalls).toHaveLength(1));
  expect(none.container.textContent).toBe("");
  none.lifecycle.unmount();
});

test("a review under way says bb is reviewing", async () => {
  const activity: AgentActivity = {
    threads: [linked("thread-review", { status: "active" })],
    latestReview: {
      threadId: "thread-review",
      headRefOid: HEAD,
      baseRefName: BASE,
      reportedAt: null,
      summary: null,
      findings: [],
    },
  };
  const slot = mount(FindingsCard, { agentActivity: () => activity });
  expect(
    await slot.findByText("bb is reviewing. Findings appear here when it reports."),
  ).toBeTruthy();
  slot.lifecycle.unmount();
});

test("linked threads open on click, and a deleted one cannot be opened", async () => {
  const activity: AgentActivity = {
    threads: [
      linked("thread-fix", { kind: "fix", title: "Fix checks on acme/api#42", status: "active" }),
      linked("thread-gone", { title: null, status: "missing", headRefOid: OLD_HEAD }),
    ],
    latestReview: null,
  };
  const slot = mount(LinkedThreads, { agentActivity: () => activity });

  const fix = await slot.findByRole("button", {
    name: /^Fix checks on acme\/api#42: Fix thread, working/,
  });
  const gone = slot.getByRole("button", { name: /^bb review: Review thread, deleted/ });
  expect((gone as HTMLButtonElement).disabled).toBe(true);
  expect(within(gone).getByText("9999999")).toBeTruthy();
  fireEvent.click(fix);
  expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId: "thread-fix" }]);
  slot.lifecycle.unmount();
});
