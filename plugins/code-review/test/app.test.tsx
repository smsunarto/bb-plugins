import "./dom.ts";
import { beforeEach, expect, test } from "bun:test";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { inboxFor } from "../src/app/inbox.tsx";
import type { Inbox, PrRef, PullRequest } from "../src/shared/schema.ts";
import {
  agentActivity,
  assignedPr,
  checks,
  inbox,
  localChanges,
  pullRequest,
} from "./app-fixtures.ts";
import { inboxTabRegistration } from "./registrations.ts";

const { fireEvent, waitFor, within } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

// The cache and the remembered inbox tab outlive the page on purpose.
// Between tests they must not.
beforeEach(() => {
  pluginQueryClient.clear();
  window.localStorage.clear();
});

type Handlers = Record<string, (input: never) => unknown>;

const baseRpc: Handlers = {
  status: () => ({ ok: true, login: "scott", accounts: ["scott"] }),
  inbox: () => inbox,
  pullRequest: () => pullRequest,
  checks: () => checks,
  changedFiles: () => ({
    ...localChanges,
    headRefOid: pullRequest.headRefOid,
    baseRefName: pullRequest.baseRefName,
  }),
  agentActivity: () => agentActivity,
  reviewInstructions: () => ({ instructions: "" }),
  // Without the GitButler plugin, so the inbox has no Unpublished tab.
  localBranches: () => ({ available: false, reason: "No GitButler plugin." }),
};

function loadApp() {
  return loadPluginApp(() => import("../src/app/app.tsx"));
}

async function registration() {
  const app = await loadApp();
  expect(app.navPanels).toHaveLength(1);
  return app.navPanels[0]!;
}

async function page(subPath: string, rpc: Handlers = baseRpc) {
  return renderSlot(await registration(), { subPath }, { rpc: rpc as never });
}

/** The Inbox tab in the page's right panel, reading the same URL as the page. */
async function inboxTab(subPath: string, rpc: Handlers = baseRpc) {
  return renderSlot(inboxTabRegistration(await loadApp()), { subPath }, { rpc: rpc as never });
}

/** Renders the Review destination's badge hook the way bb calls it: no component root of ours. */
async function badge(rpc: Handlers = baseRpc) {
  const useBadge = (await registration()).experimental_useBadge;
  if (!useBadge) throw new Error("Review registers no navigation badge");
  function Badge() {
    const value = useBadge!();
    return value === null ? null : <span>{`${value.count}|${value.label}`}</span>;
  }
  return renderSlot({ component: Badge }, {}, { rpc: rpc as never });
}

const PR_PATH = "acme/api/pull/42";

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

/** Radix tabs select on mouse down, not click. */
function selectTab(tab: HTMLElement) {
  fireEvent.mouseDown(tab, { button: 0 });
}

test("registers one Review page with its Inbox tab, under the saved ids", async () => {
  const app = await loadApp();
  const panel = await registration();
  expect(panel.id).toBe("code-review");
  expect(panel.title).toBe("Review");
  expect(panel.path).toBe("code-review");
  expect(panel.icon).toBe("GitPullRequest");
  expect(panel.fixedTabs).toBeUndefined();
  // Saved panel layouts find the tab by panel id and tab id.
  expect(
    app.tabs.map(({ id, title, context, availability, layout }) => ({
      id,
      title,
      context,
      availability,
      layout,
    })),
  ).toEqual([
    {
      id: "inbox",
      title: "Inbox",
      context: { kind: "nav-panel", panelId: "code-review" },
      availability: "fixed",
      layout: "flush",
    },
  ]);
});

test("the navigation badge counts pull requests still waiting for the viewer's review", async () => {
  const slot = await badge();
  // #42 and #7 wait on the viewer; #40 is reviewed already.
  expect(await slot.findByText("2|2 pull requests waiting for your review")).toBeTruthy();
  slot.lifecycle.unmount();
  // The Inbox tab reads the badge's cached inbox instead of asking GitHub again.
  const tab = await inboxTab("");
  await tab.findByText("Rate-limit the login endpoint", {}, { timeout: 5000 });
  expect(tab.rpcCalls.filter(({ method }) => method === "inbox")).toEqual([]);
  tab.lifecycle.unmount();
});

test("the navigation badge is empty when no review is waiting", async () => {
  const slot = await badge({ ...baseRpc, inbox: () => ({ ...inbox, assigned: [], team: [] }) });
  await waitFor(() => expect(slot.rpcCalls).toEqual([{ method: "inbox", input: null }]));
  expect(slot.container.textContent).toBe("");
  slot.lifecycle.unmount();
});

test("the navigation badge is empty while GitHub is unreachable", async () => {
  const slot = await badge({
    ...baseRpc,
    inbox: () => {
      throw new Error("gh is not signed in");
    },
  });
  await waitFor(() => expect(slot.rpcCalls.length).toBeGreaterThan(0));
  expect(slot.container.textContent).toBe("");
  slot.lifecycle.unmount();
});

test("lists what is assigned to the viewer, with a count on every tab", async () => {
  const slot = await inboxTab("");
  await slot.findByText("Rate-limit the login endpoint");

  const tabs = slot.getAllByRole("tab").map((tab) => tab.textContent);
  expect(tabs).toEqual(["Assigned to me3", "Authored by me1", "Unpublished"]);
  // A row is announced title first, as it reads.
  const rows = slot.getAllByRole("button", {
    name: /^(Rate-limit the login endpoint|Log slow queries)/,
  });
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining("Rate-limit the login endpoint"),
    expect.stringContaining("Log slow queries"),
  ]);
  const first = within(rows[0]!);
  expect(first.getByText("#42")).toBeTruthy();
  expect(first.getByText("Checks: Failed")).toBeTruthy();
  expect(first.getByText("Review requested")).toBeTruthy();
  expect(within(rows[1]!).getByText("Approved")).toBeTruthy();
  expect(rows.some((row) => row.getAttribute("aria-current") === "page")).toBe(false);
  slot.lifecycle.unmount();
});

test("with no pull request in the URL, the page points to the Inbox tab", async () => {
  const slot = await page("");
  expect(await slot.findByText("Select a pull request")).toBeTruthy();
  expect(
    slot.getByText("Choose one in the Inbox tab, or paste a GitHub link at its top."),
  ).toBeTruthy();
  expect(slot.rpcCalls.map((call) => call.method)).toEqual(["status"]);
  slot.lifecycle.unmount();
});

test("another tab shows its own list, and the choice is remembered", async () => {
  const slot = await inboxTab("");
  await slot.findByText("Rate-limit the login endpoint");

  selectTab(slot.getByRole("tab", { name: /Authored by me/ }));
  const row = await slot.findByRole("button", { name: /Drop the legacy token table/ });
  // The viewer's own draft shows GitHub's verdict, not a review request.
  expect(within(row).getByText("Draft")).toBeTruthy();
  expect(within(row).getByText("Changes requested")).toBeTruthy();
  expect(slot.queryByText("Rate-limit the login endpoint")).toBeNull();
  slot.lifecycle.unmount();

  const again = await inboxTab("");
  expect(await again.findByText("Drop the legacy token table")).toBeTruthy();
  again.lifecycle.unmount();
});

test("an empty tab says what would show up there", async () => {
  const slot = await inboxTab("", { ...baseRpc, inbox: () => ({ ...inbox, authored: [] }) });
  await slot.findByText("Rate-limit the login endpoint");
  selectTab(slot.getByRole("tab", { name: /Authored by me/ }));
  expect(await slot.findByText("No open pull requests")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a row opens its pull request in the page's URL, as the account it waits on", async () => {
  const slot = await inboxTab("");
  fireEvent.click(await slot.findByRole("button", { name: /Rate-limit the login endpoint/ }));
  expect(slot.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "code-review", options: { subPath: `@scott/${PR_PATH}` } },
  ]);
  slot.lifecycle.unmount();
});

/** gh signed in to `scott` (active) and `scott-work`, each with its own queue. */
const twoAccounts: Handlers = {
  ...baseRpc,
  status: () => ({ ok: true, login: "scott", accounts: ["scott", "scott-work"] }),
  inbox: () => ({
    ...inbox,
    accounts: ["scott", "scott-work"],
    team: [{ ...inbox.team[0]!, account: "scott-work" }],
  }),
};

test("with several accounts, each row names its account and the inbox narrows to one", async () => {
  const slot = await inboxTab("", twoAccounts);
  await slot.findByText("Rate-limit the login endpoint");
  expect(
    within(slot.getByRole("button", { name: /Rate-limit/ })).getByText("As scott"),
  ).toBeTruthy();

  fireEvent.click(slot.getByRole("button", { name: "Accounts: all" }));
  fireEvent.click(await slot.findByRole("radio", { name: "scott-work" }));

  await waitFor(() =>
    expect(slot.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Assigned to me1",
      "Authored by me0",
      "Unpublished",
    ]),
  );
  expect(window.localStorage.getItem("bb-plugin-code-review:inbox-account")).toBe("scott-work");
  slot.lifecycle.unmount();
});

test("the account menu says what waits on each account and which one gh uses", async () => {
  const slot = await inboxTab("", twoAccounts);
  fireEvent.click(await slot.findByRole("button", { name: "Accounts: all" }));
  const active = await slot.findByRole("radio", { name: "scott" });
  expect(active.getAttribute("aria-describedby")).toBeTruthy();
  const describe = (radio: HTMLElement) =>
    (radio.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  expect(describe(active)).toContain("Active gh account");
  expect(describe(slot.getByRole("radio", { name: "scott-work" }))).toBe("1 waiting for review");
  slot.lifecycle.unmount();
});

test("the account the reader chose last time is still chosen once the accounts load", async () => {
  window.localStorage.setItem("bb-plugin-code-review:inbox-account", "scott-work");
  const slot = await inboxTab("", twoAccounts);

  expect(await slot.findByRole("button", { name: "Accounts: scott-work" })).toBeTruthy();
  expect(slot.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "Assigned to me1",
    "Authored by me0",
    "Unpublished",
  ]);
  slot.lifecycle.unmount();
});

test("a chosen account gh signed out of reads as every account", async () => {
  window.localStorage.setItem("bb-plugin-code-review:inbox-account", "old-login");
  const slot = await inboxTab("", twoAccounts);

  expect(await slot.findByRole("button", { name: "Accounts: all" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("one account that failed is named above the rest of the inbox", async () => {
  const slot = await inboxTab("", {
    ...twoAccounts,
    inbox: () => ({
      ...inbox,
      accounts: ["scott", "scott-work"],
      unavailable: [{ account: "scott-work", message: "Resource protected by SAML." }],
    }),
  });
  const alert = await slot.findByRole("alert");
  expect(alert.textContent).toContain("Some accounts could not load");
  expect(alert.textContent).toContain("scott-work: Resource protected by SAML.");
  expect(slot.getByText("Rate-limit the login endpoint")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a pull request opens as the account its URL names, and every read names it", async () => {
  const slot = await page(`@scott-work/${PR_PATH}`, {
    ...twoAccounts,
    pullRequest: () => ({ ...pullRequest, account: "scott-work" }),
  });
  await slot.findByRole("heading", { level: 1 });
  await waitFor(() =>
    expect(slot.rpcCalls.filter((call) => call.method !== "status")).toEqual(
      expect.arrayContaining([
        { method: "pullRequest", input: { account: "scott-work", ref: pullRequest.ref } },
        { method: "checks", input: { account: "scott-work", ref: pullRequest.ref } },
      ]),
    ),
  );
  slot.lifecycle.unmount();
});

test("a link with no account opens as the account whose inbox lists it, else the active one", async () => {
  // Reading the inbox caches it; #7 is listed under scott-work.
  const tab = await inboxTab("", twoAccounts);
  await tab.findByText("Rate-limit the login endpoint", {}, { timeout: 5000 });
  tab.lifecycle.unmount();

  const listed = await page("acme/web/pull/7", twoAccounts);
  await listed.findByRole("heading", { level: 1 });
  expect(listed.rpcCalls).toContainEqual({
    method: "pullRequest",
    input: { account: "scott-work", ref: { owner: "acme", repo: "web", number: 7 } },
  });
  listed.lifecycle.unmount();

  const unlisted = await page("acme/web/pull/99", twoAccounts);
  await unlisted.findByRole("heading", { level: 1 });
  expect(unlisted.rpcCalls).toContainEqual({
    method: "pullRequest",
    input: { account: "scott", ref: { owner: "acme", repo: "web", number: 99 } },
  });
  unlisted.lifecycle.unmount();
});

test("the account switch opens the same pull request and tab as another account", async () => {
  const slot = await page(`@scott/${PR_PATH}/checks`, twoAccounts);
  fireEvent.click(await slot.findByRole("button", { name: "Acting as scott. Switch account" }));
  fireEvent.click(await slot.findByRole("button", { name: /Act as scott-work/ }));
  expect(slot.navigateCalls).toEqual([
    {
      method: "toPluginPanel",
      path: "code-review",
      options: { subPath: `@scott-work/${PR_PATH}/checks` },
    },
  ]);
  slot.lifecycle.unmount();
});

test("a pull request this account cannot open offers the other accounts", async () => {
  const slot = await page(`@scott-work/${PR_PATH}`, {
    ...twoAccounts,
    pullRequest: ({ account }: { account: string }) => {
      if (account === "scott-work") throw new Error("Could not resolve to a PullRequest.");
      return pullRequest;
    },
  });
  expect(await slot.findByText(/Could not open acme\/api#42/, {}, { timeout: 5_000 })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Acting as scott-work. Switch account" }));
  fireEvent.click(await slot.findByRole("button", { name: /Act as scott$/ }));
  expect(slot.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "code-review", options: { subPath: `@scott/${PR_PATH}` } },
  ]);
  slot.lifecycle.unmount();
});

test("every account's queue lists its own pull requests, and all accounts list each once", () => {
  const shared = assignedPr;
  const data: Inbox = {
    ...inbox,
    accounts: ["scott", "scott-work"],
    assigned: [
      { ...shared, account: "scott-work" },
      { ...shared, account: "scott" },
    ],
    team: [{ ...shared, account: "scott-work" }],
    authored: [],
    pinned: [],
  };

  expect(inboxFor(data, "scott-work").assigned.map((pr) => pr.account)).toEqual(["scott-work"]);
  expect(inboxFor(data, "scott-work").team.map((pr) => pr.account)).toEqual(["scott-work"]);
  const all = inboxFor(data, "all");
  expect(all.assigned.map((pr) => pr.account)).toEqual(["scott"]);
  expect(all.team).toEqual([]);
});

test("with one account, nothing on the page talks about accounts", async () => {
  const slot = await page(PR_PATH);
  await slot.findByRole("heading", { level: 1 });
  expect(slot.queryByRole("button", { name: /Switch account/ })).toBeNull();
  slot.lifecycle.unmount();
});

test("a pasted pull request link opens at once", async () => {
  const slot = await inboxTab("");
  const input = await slot.findByLabelText("Pull request link");
  fireEvent.paste(input, {
    clipboardData: { getData: () => "https://github.com/acme/web/pull/7/files#diff-1" },
  });
  expect(slot.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "code-review", options: { subPath: "acme/web/pull/7" } },
  ]);
  slot.lifecycle.unmount();
});

test("text that names no pull request is explained, not opened", async () => {
  const slot = await inboxTab("");
  const input = await slot.findByLabelText("Pull request link");
  fireEvent.change(input, { target: { value: "acme/api" } });
  fireEvent.submit(input.closest("form")!);
  expect(slot.getByRole("alert").textContent).toBe(
    "Not a pull request. Paste a github.com pull request link or owner/repo#123.",
  );
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(slot.navigateCalls).toEqual([]);

  fireEvent.change(input, { target: { value: "acme/api#9" } });
  expect(slot.queryByRole("alert")).toBeNull();
  fireEvent.submit(input.closest("form")!);
  expect(slot.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "code-review", options: { subPath: "acme/api/pull/9" } },
  ]);
  slot.lifecycle.unmount();
});

test("without a signed-in gh, the page says how to sign in and checks again", async () => {
  let asked = 0;
  const slot = await page("", {
    ...baseRpc,
    status: () => {
      asked += 1;
      return {
        ok: false,
        reason: "unauthenticated",
        message: "You are not logged into any GitHub hosts.",
      };
    },
  });
  expect(await slot.findByRole("heading", { name: "Sign in to GitHub" })).toBeTruthy();
  expect(slot.getByText("gh auth login")).toBeTruthy();
  expect(slot.getByText("You are not logged into any GitHub hosts.")).toBeTruthy();
  // The inbox is not asked for while gh cannot answer it.
  expect(slot.rpcCalls.map((call) => call.method)).toEqual(["status"]);

  fireEvent.click(slot.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(asked).toBe(2));
  slot.lifecycle.unmount();
});

test("without a signed-in gh, the Inbox tab defers to the page and asks for no inbox", async () => {
  const tab = await inboxTab("", {
    ...baseRpc,
    status: () => ({ ok: false, reason: "unauthenticated", message: "" }),
  });
  expect(await tab.findByText("GitHub is unavailable. The page says how to fix it.")).toBeTruthy();
  // Unpublished branches need no GitHub; here there is no GitButler plugin to list them.
  await waitFor(() =>
    expect(tab.rpcCalls.map((call) => call.method)).toEqual(["status", "localBranches"]),
  );
  expect(tab.getByRole("region", { name: "Unpublished branches" })).toBeTruthy();
  expect(await tab.findByText("No GitButler plugin.")).toBeTruthy();
  tab.lifecycle.unmount();
});

test("without gh at all, the page links to its installer", async () => {
  const slot = await page("", {
    ...baseRpc,
    status: () => ({ ok: false, reason: "gh-missing", message: "" }),
  });
  expect(await slot.findByRole("heading", { name: "Install the GitHub CLI" })).toBeTruthy();
  fireEvent.click(slot.getByRole("link", { name: "Install gh" }));
  expect(slot.navigateCalls).toEqual([{ method: "openUrl", url: "https://cli.github.com" }]);
  slot.lifecycle.unmount();
});

test("a pull request opens its description, checks, and diffs together, current in the Inbox tab", async () => {
  const slot = await page(PR_PATH);
  const tab = await inboxTab(PR_PATH);
  const heading = await slot.findByRole("heading", { level: 1 });
  expect(heading.textContent).toBe("Rate-limit the login endpoint #42");

  // Its inbox row is the current one.
  const row = await tab.findByRole("button", { name: /Rate-limit the login endpoint/ });
  expect(row.getAttribute("aria-current")).toBe("page");
  tab.lifecycle.unmount();

  expect(slot.getByText("ada/rate-limit")).toBeTruthy();
  expect(slot.getByText("+120")).toBeTruthy();
  expect(slot.getByText("−30")).toBeTruthy();
  expect(slot.getByText("4 files")).toBeTruthy();
  expect(slot.queryByRole("tablist", { name: "View" })).toBeNull();
  expect(await slot.findByRole("article", { name: "src/limit.ts" })).toBeTruthy();

  expect(slot.getByText("Adds a **token bucket** in front of `/login`.")).toBeTruthy();
  expect(slot.getByText("security")).toBeTruthy();
  const reviewers = within(slot.getByRole("region", { name: "Reviewers" }));
  const [scott, grace] = reviewers.getAllByRole("listitem").map((item) => within(item));
  expect(scott!.getByText("scott")).toBeTruthy();
  expect(scott!.getByText("Review requested")).toBeTruthy();
  expect(grace!.getByText("grace")).toBeTruthy();
  expect(grace!.getByText("Approved")).toBeTruthy();
  const checksSection = within(slot.getByRole("region", { name: "Checks" }));
  expect(await checksSection.findByRole("button", { name: "Fix" })).toBeTruthy();
  expect(checksSection.getByRole("list", { name: "Check runs" })).toBeTruthy();
  expect(checksSection.queryByRole("button", { expanded: false })).toBeNull();

  const activity = within(slot.getByRole("region", { name: "Activity" }));
  expect(activity.getByText("feat(auth): add a token bucket")).toBeTruthy();
  expect(activity.getByText("3333333")).toBeTruthy();
  expect(activity.getByText("Does this cover the SSO callback too?")).toBeTruthy();
  expect(activity.getByText("approved these changes")).toBeTruthy();
  expect(activity.getByText("· 2 comments")).toBeTruthy();
  expect(activity.getByText("Looks good once CI passes.")).toBeTruthy();
  expect(activity.getByText("force-pushed the branch")).toBeTruthy();

  // The drafts waiting in the pending review are on the button that posts them.
  expect(slot.getByRole("button", { name: "Submit review (2 draft comments)" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("old section links open the complete review without tabs", async () => {
  for (const section of ["summary", "changes", "checks"]) {
    const slot = await page(`${PR_PATH}/${section}`);
    expect(await slot.findByRole("region", { name: "Description" })).toBeTruthy();
    expect(await slot.findByRole("button", { name: "Fix" })).toBeTruthy();
    expect(await slot.findByRole("article", { name: "src/limit.ts" })).toBeTruthy();
    expect(slot.queryByRole("tablist", { name: "View" })).toBeNull();
    expect(slot.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  }
});

test("description and check selections survive the diff finishing its first load", async () => {
  let finish!: (value: typeof localChanges) => void;
  const pending = new Promise<typeof localChanges>((resolve) => {
    finish = resolve;
  });
  const slot = await page(PR_PATH, { ...baseRpc, changedFiles: () => pending });
  const check = (await slot.findByRole("checkbox", {
    name: /Include .* in the fix/,
  })) as HTMLInputElement;
  fireEvent.click(check);
  expect(check.checked).toBe(false);
  expect(slot.getByRole("region", { name: "Description" })).toBeTruthy();
  expect(slot.getByText("Loading changed files…")).toBeTruthy();
  finish({
    ...localChanges,
    headRefOid: pullRequest.headRefOid,
    baseRefName: pullRequest.baseRefName,
  });
  await slot.findByRole("article", { name: "src/limit.ts" });
  expect(slot.getByRole("checkbox", { name: /Include .* in the fix/ })).toBe(check);
  expect(check.checked).toBe(false);
  slot.lifecycle.unmount();
});

test("a diff load failure leaves the description and checks available", async () => {
  const slot = await page(PR_PATH, {
    ...baseRpc,
    changedFiles: () => {
      throw new Error("Files unavailable");
    },
  });
  expect(await slot.findByText("Changed files failed to load", {}, { timeout: 5000 })).toBeTruthy();
  expect(slot.getByRole("region", { name: "Description" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Fix" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("merge conflicts are flagged only while the pull request is open", async () => {
  const conflicting: PullRequest = { ...pullRequest, mergeable: "conflicting" };
  const open = await page(PR_PATH, { ...baseRpc, pullRequest: () => conflicting });
  expect(await open.findByText("Merge conflicts")).toBeTruthy();
  open.lifecycle.unmount();

  for (const state of ["closed", "merged"] as const) {
    pluginQueryClient.clear();
    const done = await page(PR_PATH, {
      ...baseRpc,
      pullRequest: () => ({ ...conflicting, state }),
    });
    await done.findByRole("heading", { level: 1 });
    await gone(() => done.queryByText("Merge conflicts"));
    done.lifecycle.unmount();
  }
});

test("Open on GitHub opens the pull request's page", async () => {
  const slot = await page(PR_PATH);
  fireEvent.click(await slot.findByRole("link", { name: "Open on GitHub" }));
  expect(slot.navigateCalls).toEqual([{ method: "openUrl", url: pullRequest.url }]);
  slot.lifecycle.unmount();
});

test("pinning shows the pull request in the inbox before the server answers", async () => {
  const pins: unknown[] = [];
  let answer: () => void = () => {};
  const rpc: Handlers = {
    ...baseRpc,
    setPinned: (input: never) => {
      pins.push(input);
      return new Promise((resolve) => {
        answer = () => resolve({ pinned: [pullRequest.ref] });
      });
    },
  };
  const slot = await page(PR_PATH, rpc);
  const tab = await inboxTab(PR_PATH, rpc);
  const pin = await slot.findByRole("button", { name: "Pin to inbox" });
  await waitFor(() => expect(pin.hasAttribute("disabled")).toBe(false));
  expect(pin.getAttribute("aria-pressed")).toBe("false");

  fireEvent.click(pin);
  const pinned = within(await tab.findByRole("region", { name: "Pinned" }));
  expect(pinned.getByText("Rate-limit the login endpoint")).toBeTruthy();
  expect(pin.getAttribute("aria-pressed")).toBe("true");
  expect(pins).toEqual([{ account: "scott", ref: pullRequest.ref, pinned: true }]);
  answer();
  tab.lifecycle.unmount();
  slot.lifecycle.unmount();
});

test("a pin the server refuses is taken back", async () => {
  const rpc: Handlers = {
    ...baseRpc,
    setPinned: () => {
      throw new Error("KV is read-only");
    },
  };
  const slot = await page(PR_PATH, rpc);
  const tab = await inboxTab(PR_PATH, rpc);
  const pin = await slot.findByRole("button", { name: "Pin to inbox" });
  await waitFor(() => expect(pin.hasAttribute("disabled")).toBe(false));
  fireEvent.click(pin);
  expect((await slot.findByRole("alert")).textContent).toBe("Could not pin: KV is read-only");
  expect(pin.getAttribute("aria-pressed")).toBe("false");
  expect(tab.queryByRole("region", { name: "Pinned" })).toBeNull();
  tab.lifecycle.unmount();
  slot.lifecycle.unmount();
});

async function openSubmit(pr: PullRequest, extra: Handlers = {}) {
  const slot = await page(PR_PATH, { ...baseRpc, pullRequest: () => pr, ...extra });
  fireEvent.click(await slot.findByRole("button", { name: /^Submit review/ }));
  const dialog = within(await slot.findByRole("dialog", { name: "Submit review" }));
  return { slot, dialog };
}

test("submits an approval with its summary and the drafts, then confirms it", async () => {
  const submitted: unknown[] = [];
  const reads = { pullRequest: 0 };
  const { slot, dialog } = await openSubmit(pullRequest, {
    pullRequest: () => {
      reads.pullRequest += 1;
      return pullRequest;
    },
    submitReview: (input: never) => {
      submitted.push(input);
      return { url: "https://github.com/acme/api/pull/42#pullrequestreview-9" };
    },
  });
  expect(dialog.getByText("2 draft comments will be posted with this review.")).toBeTruthy();
  fireEvent.change(dialog.getByLabelText("Review summary"), {
    target: { value: "  Ship it.  " },
  });
  fireEvent.click(dialog.getByRole("radio", { name: /Approve/ }));
  fireEvent.click(dialog.getByRole("button", { name: "Submit review" }));

  expect(await dialog.findByText("Your review is on GitHub.")).toBeTruthy();
  expect(submitted).toEqual([
    {
      account: "scott",
      pullRequestId: "PR_kwDOA42",
      headRefOid: pullRequest.headRefOid,
      event: "APPROVE",
      body: "Ship it.",
    },
  ]);
  // The pull request is read again, so its drafts and reviewers catch up.
  await waitFor(() => expect(reads.pullRequest).toBe(2));
  fireEvent.click(dialog.getByRole("link", { name: "View on GitHub" }));
  expect(slot.navigateCalls).toEqual([
    { method: "openUrl", url: "https://github.com/acme/api/pull/42#pullrequestreview-9" },
  ]);
  slot.lifecycle.unmount();
});

/** Escape closes the popover, which unmounts the form. */
function closeSubmit(slot: Awaited<ReturnType<typeof page>>) {
  fireEvent.keyDown(slot.getByRole("dialog", { name: "Submit review" }), { key: "Escape" });
  return gone(() => slot.queryByRole("dialog"));
}

async function reopenSubmit(slot: Awaited<ReturnType<typeof page>>) {
  fireEvent.click(slot.getByRole("button", { name: /^Submit review/ }));
  return within(await slot.findByRole("dialog", { name: "Submit review" }));
}

test("a review sent just before the popover closes still clears the form and refreshes", async () => {
  let answer: () => void = () => {};
  const reads = { pullRequest: 0 };
  const { slot, dialog } = await openSubmit(pullRequest, {
    pullRequest: () => {
      reads.pullRequest += 1;
      return pullRequest;
    },
    submitReview: () =>
      new Promise((resolve) => {
        answer = () => resolve({ url: null });
      }),
  });
  fireEvent.change(dialog.getByLabelText("Review summary"), { target: { value: "Ship it." } });
  fireEvent.click(dialog.getByRole("radio", { name: /Approve/ }));
  fireEvent.click(dialog.getByRole("button", { name: "Submit review" }));
  await dialog.findByRole("button", { name: "Submitting…" });
  await closeSubmit(slot);

  answer();
  await waitFor(() => expect(reads.pullRequest).toBe(2));
  const reopened = await reopenSubmit(slot);
  expect((reopened.getByLabelText("Review summary") as HTMLTextAreaElement).value).toBe("");
  expect((reopened.getByRole("radio", { name: /Comment/ }) as HTMLInputElement).checked).toBe(true);
  slot.lifecycle.unmount();
});

test("drafts discarded just before the popover closes still clear the form and refresh", async () => {
  let answer: () => void = () => {};
  const reads = { pullRequest: 0 };
  const { slot, dialog } = await openSubmit(pullRequest, {
    pullRequest: () => {
      reads.pullRequest += 1;
      return pullRequest;
    },
    discardReview: () =>
      new Promise((resolve) => {
        answer = () => resolve({ ok: true });
      }),
  });
  fireEvent.change(dialog.getByLabelText("Review summary"), { target: { value: "Not yet." } });
  fireEvent.click(dialog.getByRole("button", { name: "Discard drafts" }));
  fireEvent.click(dialog.getByRole("button", { name: "Discard" }));
  await dialog.findByRole("button", { name: "Discarding…" });
  await closeSubmit(slot);

  answer();
  await waitFor(() => expect(reads.pullRequest).toBe(2));
  const reopened = await reopenSubmit(slot);
  expect((reopened.getByLabelText("Review summary") as HTMLTextAreaElement).value).toBe("");
  slot.lifecycle.unmount();
});

test("reopened while the review is out, the form stays busy and sends it only once", async () => {
  const submitted: unknown[] = [];
  let answer: () => void = () => {};
  const { slot, dialog } = await openSubmit(pullRequest, {
    submitReview: (input: never) => {
      submitted.push(input);
      return new Promise((resolve) => {
        answer = () => resolve({ url: null });
      });
    },
  });
  fireEvent.change(dialog.getByLabelText("Review summary"), { target: { value: "Ship it." } });
  fireEvent.click(dialog.getByRole("button", { name: "Submit review" }));
  await dialog.findByRole("button", { name: "Submitting…" });
  await closeSubmit(slot);

  const reopened = await reopenSubmit(slot);
  const busy = reopened.getByRole("button", { name: "Submitting…" }) as HTMLButtonElement;
  expect(busy.disabled).toBe(true);
  fireEvent.click(busy);
  fireEvent.keyDown(reopened.getByLabelText("Review summary"), { key: "Enter", metaKey: true });

  answer();
  expect(await reopened.findByText("Your review is on GitHub.")).toBeTruthy();
  expect(submitted).toEqual([
    {
      account: "scott",
      pullRequestId: "PR_kwDOA42",
      headRefOid: pullRequest.headRefOid,
      event: "COMMENT",
      body: "Ship it.",
    },
  ]);
  slot.lifecycle.unmount();
});

test("reopened while drafts are being discarded, the form stays busy and discards only once", async () => {
  const discarded: unknown[] = [];
  const submitted: unknown[] = [];
  let answer: () => void = () => {};
  const { slot, dialog } = await openSubmit(pullRequest, {
    discardReview: (input: never) => {
      discarded.push(input);
      return new Promise((resolve) => {
        answer = () => resolve({ ok: true });
      });
    },
    submitReview: (input: never) => {
      submitted.push(input);
      return { url: null };
    },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Discard drafts" }));
  fireEvent.click(dialog.getByRole("button", { name: "Discard" }));
  await dialog.findByRole("button", { name: "Discarding…" });
  await closeSubmit(slot);

  const reopened = await reopenSubmit(slot);
  const busy = reopened.getByRole("button", { name: "Discarding…" }) as HTMLButtonElement;
  expect(busy.disabled).toBe(true);
  expect((reopened.getByRole("button", { name: "Keep" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(busy);
  // Nor can the drafts being deleted go out in a review meanwhile.
  fireEvent.keyDown(reopened.getByLabelText("Review summary"), { key: "Enter", metaKey: true });

  answer();
  await gone(() => slot.queryByRole("dialog"));
  expect(discarded).toEqual([{ account: "scott", pullRequestId: "PR_kwDOA42" }]);
  expect(submitted).toEqual([]);
  slot.lifecycle.unmount();
});

test("a review closed before the form shows it busy is still sent only once", async () => {
  const submitted: unknown[] = [];
  const answers: (() => void)[] = [];
  const { slot, dialog } = await openSubmit(pullRequest, {
    submitReview: (input: never) => {
      submitted.push(input);
      return new Promise((resolve) => answers.push(() => resolve({ url: null })));
    },
  });
  fireEvent.change(dialog.getByLabelText("Review summary"), { target: { value: "Ship it." } });
  fireEvent.click(dialog.getByRole("button", { name: "Submit review" }));
  // Escape lands before the render that shows the review as out.
  fireEvent.keyDown(slot.getByRole("dialog", { name: "Submit review" }), { key: "Escape" });
  await gone(() => slot.queryByRole("dialog"));

  const reopened = await reopenSubmit(slot);
  fireEvent.click(reopened.getByRole("button", { name: /^Submit/ }));
  fireEvent.keyDown(reopened.getByLabelText("Review summary"), { key: "Enter", metaKey: true });
  await waitFor(() =>
    expect(reopened.getByRole("button", { name: "Submitting…" }).hasAttribute("disabled")).toBe(
      true,
    ),
  );

  for (const answer of answers) answer();
  expect(await reopened.findByText("Your review is on GitHub.")).toBeTruthy();
  expect(submitted).toEqual([
    {
      account: "scott",
      pullRequestId: "PR_kwDOA42",
      headRefOid: pullRequest.headRefOid,
      event: "COMMENT",
      body: "Ship it.",
    },
  ]);
  slot.lifecycle.unmount();
});

test("a page opened again while the review is out shows it busy and does not send it twice", async () => {
  const submitted: unknown[] = [];
  let answer: () => void = () => {};
  const rpc: Handlers = {
    submitReview: (input: never) => {
      submitted.push(input);
      return new Promise((resolve) => {
        answer = () => resolve({ url: null });
      });
    },
  };
  const first = await openSubmit(pullRequest, rpc);
  fireEvent.change(first.dialog.getByLabelText("Review summary"), {
    target: { value: "Ship it." },
  });
  fireEvent.click(first.dialog.getByRole("button", { name: "Submit review" }));
  first.slot.lifecycle.unmount();

  const { slot, dialog } = await openSubmit(pullRequest, rpc);
  const busy = dialog.getByRole("button", { name: "Submitting…" }) as HTMLButtonElement;
  expect(busy.disabled).toBe(true);
  // The drafts alone are enough to send, so only the request that is out holds this back.
  fireEvent.keyDown(dialog.getByLabelText("Review summary"), { key: "Enter", metaKey: true });

  answer();
  await dialog.findByRole("button", { name: "Submit review" });
  expect(submitted).toHaveLength(1);
  slot.lifecycle.unmount();
});

test("the pull request opened under another casing of its URL does not send the review twice", async () => {
  const submitted: unknown[] = [];
  let answer: () => void = () => {};
  const rpc: Handlers = {
    ...baseRpc,
    // GitHub finds the pull request in any casing, and the server names it as asked.
    pullRequest: ({ ref }: { ref: PrRef }) => ({ ...pullRequest, ref }),
    submitReview: (input: never) => {
      submitted.push(input);
      return new Promise((resolve) => {
        answer = () => resolve({ url: null });
      });
    },
  };
  const first = await page(PR_PATH, rpc);
  fireEvent.click(await first.findByRole("button", { name: /^Submit review/ }));
  const firstDialog = within(await first.findByRole("dialog", { name: "Submit review" }));
  fireEvent.change(firstDialog.getByLabelText("Review summary"), { target: { value: "Ship it." } });
  fireEvent.click(firstDialog.getByRole("button", { name: "Submit review" }));
  await firstDialog.findByRole("button", { name: "Submitting…" });
  first.lifecycle.unmount();

  const slot = await page("ACME/API/pull/42", rpc);
  fireEvent.click(await slot.findByRole("button", { name: /^Submit review/ }));
  const dialog = within(await slot.findByRole("dialog", { name: "Submit review" }));
  fireEvent.keyDown(dialog.getByLabelText("Review summary"), { key: "Enter", metaKey: true });
  fireEvent.click(dialog.getByRole("button", { name: /^Submit/ }));

  answer();
  await dialog.findByRole("button", { name: "Submit review" });
  expect(submitted).toEqual([
    {
      account: "scott",
      pullRequestId: "PR_kwDOA42",
      headRefOid: pullRequest.headRefOid,
      event: "COMMENT",
      body: "Ship it.",
    },
  ]);
  slot.lifecycle.unmount();
});

test("a review refused after the page was opened again shows the refusal there", async () => {
  let refuse: () => void = () => {};
  const rpc: Handlers = {
    submitReview: () =>
      new Promise((_resolve, reject) => {
        refuse = () => reject(new Error("Review cannot be submitted on a stale commit."));
      }),
  };
  const first = await openSubmit(pullRequest, rpc);
  fireEvent.change(first.dialog.getByLabelText("Review summary"), {
    target: { value: "Ship it." },
  });
  fireEvent.click(first.dialog.getByRole("button", { name: "Submit review" }));
  await first.dialog.findByRole("button", { name: "Submitting…" });
  first.slot.lifecycle.unmount();

  const { slot, dialog } = await openSubmit(pullRequest, rpc);
  const body = dialog.getByLabelText("Review summary") as HTMLTextAreaElement;
  fireEvent.change(body, { target: { value: "Needs work" } });
  refuse();
  expect((await dialog.findByRole("alert")).textContent).toBe(
    "GitHub did not take the reviewReview cannot be submitted on a stale commit.",
  );
  expect(body.value).toBe("Needs work");
  const submit = dialog.getByRole("button", { name: "Submit review" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(false);

  // Closing the popover dismisses the refusal, and only the refusal.
  await closeSubmit(slot);
  const reopened = await reopenSubmit(slot);
  expect(reopened.queryByRole("alert")).toBeNull();
  expect((reopened.getByLabelText("Review summary") as HTMLTextAreaElement).value).toBe(
    "Needs work",
  );
  slot.lifecycle.unmount();
});

test("a refusal that lands as the popover closes is kept for the next opening", async () => {
  let refuse: () => void = () => {};
  const { slot, dialog } = await openSubmit(pullRequest, {
    submitReview: () =>
      new Promise((_resolve, reject) => {
        refuse = () => reject(new Error("Review cannot be submitted on a stale commit."));
      }),
  });
  fireEvent.change(dialog.getByLabelText("Review summary"), { target: { value: "Ship it." } });
  fireEvent.click(dialog.getByRole("button", { name: "Submit review" }));
  await dialog.findByRole("button", { name: "Submitting…" });

  // Escape lands the moment the refusal is cached, before any render shows it.
  const cache = pluginQueryClient.getMutationCache();
  const stop = cache.subscribe((event) => {
    if (event.type !== "updated" || event.mutation.state.status !== "error") return;
    stop();
    fireEvent.keyDown(slot.getByRole("dialog", { name: "Submit review" }), { key: "Escape" });
  });
  refuse();
  await gone(() => slot.queryByRole("dialog"));

  const reopened = await reopenSubmit(slot);
  expect((await reopened.findByRole("alert")).textContent).toBe(
    "GitHub did not take the reviewReview cannot be submitted on a stale commit.",
  );
  // Seen now, so this close dismisses it.
  await closeSubmit(slot);
  expect((await reopenSubmit(slot)).queryByRole("alert")).toBeNull();
  slot.lifecycle.unmount();
});

test("a discard refused after the page was opened again shows the refusal there", async () => {
  let refuse: () => void = () => {};
  const rpc: Handlers = {
    discardReview: () =>
      new Promise((_resolve, reject) => {
        refuse = () => reject(new Error("Pending review was already submitted."));
      }),
  };
  const first = await openSubmit(pullRequest, rpc);
  fireEvent.click(first.dialog.getByRole("button", { name: "Discard drafts" }));
  fireEvent.click(first.dialog.getByRole("button", { name: "Discard" }));
  await first.dialog.findByRole("button", { name: "Discarding…" });
  first.slot.lifecycle.unmount();

  const { slot, dialog } = await openSubmit(pullRequest, rpc);
  const body = dialog.getByLabelText("Review summary") as HTMLTextAreaElement;
  fireEvent.change(body, { target: { value: "Needs work" } });
  refuse();
  expect((await dialog.findByRole("alert")).textContent).toBe(
    "Pending review was already submitted.",
  );
  expect(body.value).toBe("Needs work");

  // Keep dismisses the refusal, so the next confirmation starts clean.
  fireEvent.click(dialog.getByRole("button", { name: "Keep" }));
  fireEvent.click(await dialog.findByRole("button", { name: "Discard drafts" }));
  expect(dialog.queryByRole("alert")).toBeNull();
  slot.lifecycle.unmount();
});

test("drafts discarded and closed before the form shows it busy are discarded only once", async () => {
  const discarded: unknown[] = [];
  const answers: (() => void)[] = [];
  const { slot, dialog } = await openSubmit(pullRequest, {
    discardReview: (input: never) => {
      discarded.push(input);
      return new Promise((resolve) => answers.push(() => resolve({ ok: true })));
    },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Discard drafts" }));
  fireEvent.click(dialog.getByRole("button", { name: "Discard" }));
  // Escape lands before the render that shows the discard as out.
  fireEvent.keyDown(slot.getByRole("dialog", { name: "Submit review" }), { key: "Escape" });
  await gone(() => slot.queryByRole("dialog"));

  // The viewer asks to discard again, the way the reopened form offers it.
  const reopened = await reopenSubmit(slot);
  fireEvent.click(reopened.getByRole("button", { name: /^Discard( drafts|ing…)$/ }));
  fireEvent.click(reopened.getByRole("button", { name: /^Discard(ing…)?$/ }));
  await waitFor(() =>
    expect(reopened.getByRole("button", { name: "Discarding…" }).hasAttribute("disabled")).toBe(
      true,
    ),
  );

  for (const answer of answers) answer();
  await gone(() => slot.queryByRole("dialog"));
  expect(discarded).toEqual([{ account: "scott", pullRequestId: "PR_kwDOA42" }]);
  slot.lifecycle.unmount();
});

test("the author can only comment, and is told why", async () => {
  const { slot, dialog } = await openSubmit({
    ...pullRequest,
    viewer: { login: "scott", isAuthor: true, canApprove: false },
  });
  const approve = dialog.getByRole("radio", { name: /Approve/ }) as HTMLInputElement;
  const requestChanges = dialog.getByRole("radio", { name: /Request changes/ }) as HTMLInputElement;
  expect(approve.disabled).toBe(true);
  expect(requestChanges.disabled).toBe(true);
  expect((dialog.getByRole("radio", { name: /Comment/ }) as HTMLInputElement).checked).toBe(true);
  expect(
    dialog.getByText("You opened this pull request, so you can only comment on it."),
  ).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a comment with no text and no drafts cannot be sent", async () => {
  const { slot, dialog } = await openSubmit({ ...pullRequest, pendingReview: null });
  const submit = dialog.getByRole("button", { name: "Submit review" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect(dialog.getByText("Write a comment to submit.")).toBeTruthy();
  // No pending review means nothing to discard.
  expect(dialog.queryByRole("button", { name: "Discard drafts" })).toBeNull();

  fireEvent.change(dialog.getByLabelText("Review summary"), { target: { value: "Thoughts" } });
  expect(submit.disabled).toBe(false);
  slot.lifecycle.unmount();
});

test("GitHub's refusal is shown in the form, which keeps the text", async () => {
  const { slot, dialog } = await openSubmit(pullRequest, {
    submitReview: () => {
      throw new Error("Review cannot be submitted on a stale commit.");
    },
  });
  const body = dialog.getByLabelText("Review summary") as HTMLTextAreaElement;
  fireEvent.change(body, { target: { value: "Needs work" } });
  fireEvent.click(dialog.getByRole("button", { name: "Submit review" }));
  expect((await dialog.findByRole("alert")).textContent).toBe(
    "GitHub did not take the reviewReview cannot be submitted on a stale commit.",
  );
  expect(body.value).toBe("Needs work");

  // The refusal belongs to that attempt. Opening again starts clean but keeps the text.
  await closeSubmit(slot);
  const reopened = await reopenSubmit(slot);
  expect(reopened.queryByRole("alert")).toBeNull();
  expect((reopened.getByLabelText("Review summary") as HTMLTextAreaElement).value).toBe(
    "Needs work",
  );
  slot.lifecycle.unmount();
});

test("a failed discard is forgotten once the viewer keeps the drafts or closes the popover", async () => {
  const { slot, dialog } = await openSubmit(pullRequest, {
    discardReview: () => {
      throw new Error("Pending review was already submitted.");
    },
  });
  const refused = async () =>
    expect((await dialog.findByRole("alert")).textContent).toBe(
      "Pending review was already submitted.",
    );

  fireEvent.click(dialog.getByRole("button", { name: "Discard drafts" }));
  fireEvent.click(dialog.getByRole("button", { name: "Discard" }));
  await refused();
  fireEvent.click(dialog.getByRole("button", { name: "Keep" }));
  fireEvent.click(dialog.getByRole("button", { name: "Discard drafts" }));
  await gone(() => dialog.queryByRole("alert"));

  fireEvent.click(dialog.getByRole("button", { name: "Discard" }));
  await refused();
  await closeSubmit(slot);
  const reopened = await reopenSubmit(slot);
  fireEvent.click(reopened.getByRole("button", { name: "Discard drafts" }));
  expect(reopened.queryByRole("alert")).toBeNull();
  slot.lifecycle.unmount();
});

test("discarding drafts asks first, then deletes the pending review", async () => {
  const discarded: unknown[] = [];
  const { slot, dialog } = await openSubmit(pullRequest, {
    discardReview: (input: never) => {
      discarded.push(input);
      return { ok: true };
    },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Discard drafts" }));
  expect(
    dialog.getByText(
      "Discard 2 draft comments? This deletes them from GitHub and cannot be undone.",
    ),
  ).toBeTruthy();
  expect(discarded).toEqual([]);
  fireEvent.click(dialog.getByRole("button", { name: "Discard" }));
  await waitFor(() =>
    expect(discarded).toEqual([{ account: "scott", pullRequestId: "PR_kwDOA42" }]),
  );
  await gone(() => slot.queryByRole("dialog"));
  slot.lifecycle.unmount();
});

test("a pull request GitHub cannot find says so, with a way back", async () => {
  const slot = await page("acme/api/pull/999", {
    ...baseRpc,
    pullRequest: () => {
      throw new Error("Could not resolve to a PullRequest with the number of 999.");
    },
  });
  const alert = await slot.findByRole("alert", {}, { timeout: 5_000 });
  expect(alert.textContent).toContain("Could not open acme/api#999");
  expect(alert.textContent).toContain("Could not resolve to a PullRequest with the number of 999.");
  fireEvent.click(within(alert).getByRole("button", { name: "Back to inbox" }));
  expect(slot.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "code-review", options: { subPath: "" } },
  ]);
  slot.lifecycle.unmount();
});

test("a URL that names no pull request offers the way back", async () => {
  const slot = await page("acme/api/issues/3");
  fireEvent.click(await slot.findByRole("button", { name: "Back to inbox" }));
  expect(slot.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "code-review", options: { subPath: "", replace: true } },
  ]);
  slot.lifecycle.unmount();
});
