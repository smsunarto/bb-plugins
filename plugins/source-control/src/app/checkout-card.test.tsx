// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Branch, ThreadChange, WorkspaceValue } from "../core/change.ts";
import { checkoutWorkKey, type CheckoutWork } from "../core/checkout-work.ts";
import { changeKeySchema } from "../core/ids.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { ChangeDirective } from "./chat-card.tsx";

afterEach(cleanup);

const PATH = "/home/scott/git/dotfiles";
const BRANCH = "scott/zsh";
const KEY = changeKeySchema.parse(`gh:scott/dotfiles:scott:${BRANCH}`);
const message = { id: "m1", threadId: "thread-a", turnId: null, projectId: null };

const branch = (overrides: Partial<Branch> = {}): Branch => ({
  name: BRANCH,
  head: "abc1234",
  remote: null,
  status: "unpushed",
  push: "push",
  ahead: 2,
  behind: 0,
  newUpstream: 0,
  reviewId: null,
  commits: [
    { id: "abc1234", subject: "Load zsh plugins lazily", createdAt: null, conflicted: false },
    { id: "abc1233", subject: "Add the plugin list", createdAt: null, conflicted: false },
  ],
  moreCommits: 0,
  upstreamCommits: [],
  ...overrides,
});

/** The named checkout as the server read it: `only` on its checked-out branch. */
function work(only: Branch, overrides: Partial<WorkspaceValue> = {}): CheckoutWork {
  const row: ThreadChange = {
    state: "checkout",
    placement: { hostId: "host-a", hostName: "dev-pc", path: PATH, environmentId: "env" },
    readAsGit: false,
    branch: only.name,
    key: KEY,
    local: {
      read: {
        value: {
          provider: "git",
          path: PATH,
          commonDir: `${PATH}/.git`,
          checkedOut: only.name,
          github: { repo: { owner: "scott", name: "dotfiles" }, headOwner: "scott" },
          uncommitted: [],
          moreUncommitted: 0,
          conflicted: [],
          stacks: [{ key: only.name, branches: [only], assigned: [] }],
          target: { ref: "origin/main", head: "a41c9e2", behind: 0, base: null, lastFetched: null },
          ...overrides,
        },
        at: Date.now(),
      },
      problem: null,
    },
    forge: { read: { value: null, at: Date.now() }, problem: null },
  };
  return { row, reviewable: false };
}

function render(attributes: Record<string, string>, answer: CheckoutWork) {
  const asked: string[] = [];
  const shipped: unknown[] = [];
  const slot = renderSlot(
    { component: ChangeDirective },
    { attributes, source: "::source-control", message, openWorkspaceFile: null },
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      rpc: {
        workAtCheckout: ({ keys }: { keys: string[] }) => {
          asked.push(...keys);
          return Object.fromEntries(keys.map((key) => [key, answer]));
        },
        shipThread: (input: unknown) => {
          shipped.push(input);
          return { ok: true };
        },
      } as never,
    },
  );
  return { slot, asked, shipped };
}

test("a checkout named by path shows its unpushed branch, where it is, and ships it", async () => {
  const { slot, asked, shipped } = render({ path: `${PATH}/` }, work(branch()));
  const card = await slot.findByTestId("sc-card-branch");
  const key = checkoutWorkKey({ threadId: "thread-a", path: PATH, branch: null });
  expect(asked).toContain(key);
  expect(card.textContent).toContain("Load zsh plugins lazily");
  expect(card.textContent).toContain(BRANCH);
  expect(card.textContent).toContain("2 commits");
  expect(card.textContent).toContain(`dev-pc:${PATH}`);
  slot.getByTestId("sc-card-ship").click();
  await waitFor(() => expect(shipped).toEqual([{ threadId: "thread-a", at: key }]));
  expect(await slot.findByText("Asked the agent to ship it.")).toBeTruthy();
});

test("a named checkout with only uncommitted files, or nothing, says so", async () => {
  const none = branch({ commits: [], status: "pushed", push: "none", ahead: 0 });
  const dirty = render(
    { path: PATH, branch: BRANCH },
    work(none, { uncommitted: [{ path: ".zshrc", kind: "modified" }] }),
  );
  expect((await dirty.slot.findByTestId("sc-card-uncommitted")).textContent).toContain(
    `1 uncommitted file in dev-pc:${PATH}`,
  );
  expect(dirty.asked).toContain(
    checkoutWorkKey({ threadId: "thread-a", path: PATH, branch: BRANCH }),
  );
  cleanup();
  const clean = render({ path: PATH }, work(none));
  expect((await clean.slot.findByTestId("sc-card-clean")).textContent).toContain(
    "Nothing left to ship",
  );
  cleanup();
  const gone = render(
    { path: PATH },
    {
      row: { state: "none", reason: `No git repository bb can read at ${PATH} on dev-pc.` },
      reviewable: false,
    },
  );
  expect((await gone.slot.findByTestId("sc-card-none")).textContent).toContain("No git repository");
});

test("a branch card drawn from a read that could not be renewed says so", async () => {
  const answer = work(branch());
  if (answer.row.state !== "checkout") throw new Error("fixture");
  answer.row.local.problem = { kind: "host-offline", host: "dev-pc" };
  const { slot } = render({ path: PATH }, answer);
  await slot.findByTestId("sc-card-branch");
  expect(slot.getByTestId("sc-card-stale").textContent).toContain("This is what bb last read.");
});

test("a path bb cannot read as one is refused without asking the server", () => {
  for (const path of ["~/git/dotfiles", "git/dotfiles", ""]) {
    const { slot, asked } = render({ path }, work(branch()));
    expect(slot.getByTestId("sc-card-invalid").textContent).toContain("absolute path");
    expect(asked).toEqual([]);
    cleanup();
  }
  const { slot } = render({ branch: "two words" }, work(branch()));
  expect(slot.getByTestId("sc-card-invalid").textContent).toContain("not a branch name");
});
