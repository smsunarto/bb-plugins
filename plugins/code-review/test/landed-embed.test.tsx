import "./dom.ts";
import { beforeEach, expect, test } from "bun:test";
import type {
  PluginSidebarThread,
  PluginThreadActionEntry,
  PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { queryClient } from "../src/app/query.ts";
import { landedDirective, parseLandedAttributes } from "../src/shared/landed.ts";
import type { Landed } from "../src/shared/landed.ts";
import { prSubPath } from "../src/shared/schema.ts";

const { fireEvent, waitFor } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

beforeEach(() => queryClient.clear());

const SHA = "b".repeat(40);
const PR = { owner: "acme", repo: "api", number: 7 };
const OPEN_PR = { owner: "acme", repo: "api", number: 9 };
const COMMIT = { owner: "acme", repo: "api", sha: SHA };
const ATTRIBUTES = { prs: "acme/api#7", commits: `acme/api@${SHA}`, account: "scott" };

const LANDED: Landed = {
  prs: [
    {
      ref: PR,
      title: "Rate limit the API",
      url: "https://github.com/acme/api/pull/7",
      state: "merged",
    },
  ],
  commits: [
    {
      ref: COMMIT,
      branch: "main",
      landed: true,
      headline: "Ship the limiter",
      url: `https://github.com/acme/api/commit/${SHA}`,
    },
  ],
};

const THREAD = {
  id: "thread-1",
  projectId: "proj-1",
  parentThreadId: null,
  archivedAt: null,
  pinnedAt: null,
  sectionId: null,
  isUnread: false,
  status: "idle",
  environment: { id: "env-1", path: "/home/example/api" },
} as unknown as PluginSidebarThread;

async function card({
  attributes = ATTRIBUTES as Record<string, string>,
  landed = () => LANDED as unknown,
  threads = [THREAD],
  archive = (_thread: PluginThreadActionTarget) => {},
  stored = { archivedAt: null as number | null },
}: {
  attributes?: Record<string, string>;
  landed?: () => unknown;
  threads?: PluginSidebarThread[];
  archive?: (thread: PluginThreadActionTarget) => void;
  /** What bb answers for a thread the sidebar's active list leaves out. */
  stored?: { archivedAt: number | null };
} = {}) {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = app.messageDirectives.find((each) => each.id === "code-review-landed");
  if (!directive) throw new Error("No code-review-landed directive");
  return renderSlot(
    directive,
    {
      attributes,
      source: "::code-review-landed{invalid}",
      message: { id: "msg-1", threadId: "thread-1", turnId: "turn-1", projectId: "proj-1" },
      openWorkspaceFile: null,
    },
    {
      rpc: { landed },
      sidebarThreads: { status: "ready", threads },
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            ({
              ...makeThreadResponse({ id: threadId, projectId: "proj-1", environmentId: "env-1" }),
              archivedAt: stored.archivedAt,
            }) as never,
        },
      },
      threadActions: (thread, _options): PluginThreadActionEntry[] => [
        {
          key: "bb--core/archive",
          pluginId: "bb--core",
          group: "lifecycle",
          action: { label: "Archive", icon: "Archive", run: async () => archive(thread) },
        },
      ],
    },
  );
}

test("the directive round-trips through its attributes, and junk falls back to its source", async () => {
  const target = { account: "scott", prs: [PR, OPEN_PR], commits: [COMMIT] };
  const directive = landedDirective(target);
  const attributes = Object.fromEntries(
    [...directive.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key!, value!]),
  );
  expect(parseLandedAttributes(attributes)).toEqual(target);
  expect(parseLandedAttributes({ account: "scott" })).toBeNull();
  expect(parseLandedAttributes({ ...ATTRIBUTES, prs: "javascript:alert(1)" })).toBeNull();
  expect(
    parseLandedAttributes({ ...ATTRIBUTES, prs: "https://github.com/acme/api/pull/7" }),
  ).toBeNull();

  const slot = await card({ attributes: { prs: "nope", account: "scott" } });
  try {
    expect(slot.getByText("::code-review-landed{invalid}")).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("the card lists what landed, opens a pull request in Review, and settles the thread", async () => {
  const archived: PluginThreadActionTarget[] = [];
  const slot = await card({ archive: (thread) => archived.push(thread) });
  try {
    // The references show before GitHub answers.
    expect(slot.getByText("acme/api#7")).toBeTruthy();
    await slot.findByText("Rate limit the API");
    expect(slot.getByText("Ship the limiter")).toBeTruthy();
    expect(slot.getByText("Landed")).toBeTruthy();
    expect(slot.getByText("1 pull request · 1 commit")).toBeTruthy();

    fireEvent.click(slot.getByText("Rate limit the API"));
    expect(slot.navigateCalls.at(-1)).toEqual({
      method: "toPluginPanel",
      path: "code-review",
      options: { subPath: prSubPath(PR, "summary", "scott") },
    });

    fireEvent.click(slot.getByRole("button", { name: "Settle thread" }));
    await waitFor(() => expect(archived.map((thread) => thread.id)).toEqual(["thread-1"]));
    expect(archived[0]?.environment).toEqual({ id: "env-1", path: "/home/example/api" });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("open work counts toward the status, and a GitHub failure leaves Settle usable", async () => {
  const partial = await card({
    attributes: { prs: "acme/api#7 acme/api#9", account: "scott" },
    landed: () => ({
      prs: [
        LANDED.prs[0],
        {
          ref: OPEN_PR,
          title: "Follow-up",
          url: "https://github.com/acme/api/pull/9",
          state: "open",
        },
      ],
      commits: [],
    }),
  });
  try {
    await partial.findByText("1 of 2 landed");
    // The heading counts what is listed; it does not claim the open one landed.
    expect(partial.getByText("2 pull requests")).toBeTruthy();
  } finally {
    partial.lifecycle.unmount();
  }
  queryClient.clear();

  const offline = await card({
    landed: () => {
      throw new Error("GitHub CLI timed out after 30s.");
    },
  });
  try {
    // One retry, a second apart, before the failure shows.
    await offline.findByText(
      "GitHub CLI timed out after 30s.",
      { exact: false },
      { timeout: 3000 },
    );
    expect(offline.getByText("Unavailable")).toBeTruthy();
    expect(offline.getByText("acme/api#7")).toBeTruthy();
    expect(
      (offline.getByRole("button", { name: "Settle thread" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  } finally {
    offline.lifecycle.unmount();
  }
});

test("only a thread bb reports archived reads as settled; one the list leaves out still settles", async () => {
  const archivedSlot = await card({
    threads: [],
    stored: { archivedAt: Date.parse("2026-10-28T00:00:00Z") },
  });
  try {
    const button = (await archivedSlot.findByRole("button", {
      name: "Settled",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  } finally {
    archivedSlot.lifecycle.unmount();
  }
  queryClient.clear();

  const archived: PluginThreadActionTarget[] = [];
  const stored = { archivedAt: null as number | null };
  const hidden = await card({
    threads: [],
    stored,
    archive: (thread) => {
      archived.push(thread);
      stored.archivedAt = Date.parse("2026-10-28T00:00:00Z");
    },
  });
  try {
    // A placeholder shows until bb answers, then the live button replaces it.
    const settle = () => hidden.getByRole("button", { name: "Settle thread" }) as HTMLButtonElement;
    await waitFor(() => expect(settle().disabled).toBe(false));
    const button = settle();
    expect(hidden.queryByRole("button", { name: "Settled" })).toBeNull();
    fireEvent.click(button);
    await waitFor(() =>
      expect(archived.map((thread) => [thread.id, thread.environment])).toEqual([
        ["thread-1", { id: "env-1", path: null }],
      ]),
    );
    // bb's read now reports it archived, so the button cannot archive it twice.
    const settled = (await hidden.findByRole("button", { name: "Settled" })) as HTMLButtonElement;
    expect(settled.disabled).toBe(true);
  } finally {
    hidden.lifecycle.unmount();
  }
});

test("a commit shared by two repositories shows each repository's own landing", async () => {
  const slot = await card({
    attributes: { commits: `acme/api@${SHA} acme/fork@${SHA.slice(0, 7)}`, account: "scott" },
    landed: () => ({
      prs: [],
      commits: [
        {
          ...LANDED.commits[0],
          ref: { ...COMMIT, owner: "Acme", repo: "Fork" },
          landed: false,
          headline: "In the fork",
        },
        LANDED.commits[0],
      ],
    }),
  });
  try {
    await slot.findByText("In the fork");
    expect(slot.getByText("Ship the limiter")).toBeTruthy();
    expect(slot.getByLabelText("on main")).toBeTruthy();
    expect(slot.getByLabelText("not on main")).toBeTruthy();
    expect(slot.getByText("1 of 2 landed")).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
  }
});
