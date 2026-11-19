// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { UrlLink, type ExperimentalPanelController } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { changeKeySchema } from "../core/ids.ts";
import { parsePrLink } from "../core/watch.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { resetKnownPullRequests, usePullRequestClick } from "./open-pull-request.ts";

afterEach(() => {
  cleanup();
  resetKnownPullRequests();
});

const PR = "https://github.com/Acme/API/pull/12";
const KEY = changeKeySchema.parse("gh:acme/api:scott:scott/route");

function PullRequestLink({ href }: { href: string }) {
  const onClick = usePullRequestClick("thread-a", href);
  return (
    <UrlLink href={href} onClick={onClick}>
      #12
    </UrlLink>
  );
}

function render(
  href: string,
  legacyChange: (input: { keys: string[] }) => unknown,
  panel: Partial<ExperimentalPanelController> = { openTab: () => true },
) {
  const lookups: string[][] = [];
  const slot = renderSlot({ component: PullRequestLink as never }, { href } as never, {
    experimental_rpcContract: sourceControlContract,
    pluginId: "source-control",
    experimental_panel: panel,
    openUrl: () => true,
    rpc: {
      legacyChange: (input: { keys: string[] }) => {
        lookups.push(input.keys);
        return legacyChange(input);
      },
    } as never,
  });
  return { slot, lookups };
}

const found =
  (key: string | null, problem: string | null = null) =>
  () => ({
    "pr:acme/api#12": { key, problem },
  });

test("a pull request link opens its Change's review beside the thread, not GitHub", async () => {
  const { slot, lookups } = render(PR, found(KEY));
  fireEvent.click(slot.getByRole("link", { name: "#12" }));
  await waitFor(() =>
    expect(slot.inspection.experimental_panelCalls).toEqual([
      {
        method: "openTab",
        options: {
          tab: { id: "review", context: { kind: "thread" }, availability: "action" },
          params: { key: KEY },
          title: "Review · scott/route",
        },
      },
    ]),
  );
  expect(lookups).toEqual([["pr:acme/api#12"]]);
  expect(slot.inspection.navigateCalls).toEqual([]);
});

test("a second click opens at once, without asking the server again", async () => {
  const { slot, lookups } = render(PR, found(KEY));
  const link = slot.getByRole("link", { name: "#12" });
  fireEvent.click(link);
  await waitFor(() => expect(slot.inspection.experimental_panelCalls).toHaveLength(1));
  fireEvent.click(link);
  await waitFor(() => expect(slot.inspection.experimental_panelCalls).toHaveLength(2));
  expect(lookups).toHaveLength(1);
});

test("a pull request Source Control cannot read opens on GitHub", async () => {
  const { slot } = render(PR, found(null, "gh cannot read Acme/API"));
  fireEvent.click(slot.getByRole("link", { name: "#12" }));
  await waitFor(() =>
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openUrl", url: PR }]),
  );
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("a failed read opens on GitHub", async () => {
  const { slot } = render(PR, () => {
    throw new Error("offline");
  });
  fireEvent.click(slot.getByRole("link", { name: "#12" }));
  await waitFor(() =>
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openUrl", url: PR }]),
  );
});

test("a modified click is the browser's: it reads nothing and opens no review", async () => {
  const { slot, lookups } = render(PR, found(KEY));
  const link = slot.getByRole("link", { name: "#12" });
  // The browser would open a new tab; jsdom cannot navigate, so stop it after the app saw the click.
  const stop = (event: Event) => event.preventDefault();
  document.addEventListener("click", stop);
  fireEvent.click(link, { metaKey: true });
  fireEvent.click(link, { ctrlKey: true });
  fireEvent.click(link, { shiftKey: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  document.removeEventListener("click", stop);
  expect(lookups).toEqual([]);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("a deep link into a pull request goes to GitHub as it did", async () => {
  const deep = `${PR}#issuecomment-1`;
  const { slot, lookups } = render(deep, found(KEY));
  fireEvent.click(slot.getByRole("link", { name: "#12" }));
  await waitFor(() =>
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openUrl", url: deep }]),
  );
  expect(lookups).toEqual([]);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("only a link to a pull request itself is one Review can show", () => {
  expect(parsePrLink(PR)).toEqual({ owner: "Acme", repo: "API", number: 12 });
  expect(parsePrLink(`${PR}/`)).toEqual({ owner: "Acme", repo: "API", number: 12 });
  expect(parsePrLink("https://www.github.com/acme/api/pull/3")).toMatchObject({ number: 3 });
  for (const other of [
    `${PR}/files`,
    `${PR}/commits/abc1234`,
    `${PR}#issuecomment-1`,
    `${PR}?w=1`,
    "https://github.com/acme/api/issues/12",
    "https://gitlab.com/acme/api/pull/12",
    "http://github.com/acme/api/pull/12",
    "acme/api#12",
    "https://github.com/acme/api/pull/0",
  ])
    expect(parsePrLink(other)).toBeNull();
});
