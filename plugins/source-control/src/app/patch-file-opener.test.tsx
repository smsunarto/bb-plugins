// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { MAX_PATCH_BYTES, patchFileUrl } from "./patch-file-opener.tsx";

// Pierre's diff element adopts a constructed stylesheet; jsdom has no `replaceSync`.
const sheet = CSSStyleSheet.prototype as unknown as { replaceSync?: (text: string) => void };
sheet.replaceSync ??= () => {};

const app = await loadPluginApp(() => import("./app.tsx"));
const opener = app.fileOpeners.find((registration) => registration.id === "patch")!;

const FIXTURES = join(import.meta.dirname, "../../test/fixtures/patch-file");
const STORAGE: PluginFileOpenerSource = {
  kind: "thread-storage",
  threadId: "thr_a",
  environmentId: null,
  projectId: null,
};

function Original() {
  return <pre data-testid="bb-original">BB's text preview</pre>;
}

function open(body: string, init: ResponseInit = {}) {
  const fetch = vi.fn(async () => new Response(body, init));
  vi.stubGlobal("fetch", fetch);
  renderSlot(opener, {
    path: "work/change.patch",
    source: STORAGE,
    Original,
  });
  return fetch;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("registers for .patch and .diff", () => {
  expect(opener).toMatchObject({ extensions: ["patch", "diff"], title: "Diff view" });
});

test("reads the file from BB's raw file route for each source", () => {
  expect(patchFileUrl("work/my change.patch", STORAGE)).toBe(
    "/api/v1/threads/thr_a/thread-storage/files/work/my%20change.patch",
  );
  expect(
    patchFileUrl("a.diff", {
      kind: "workspace",
      threadId: null,
      environmentId: "env_1",
      projectId: "p",
    }),
  ).toBe("/api/v1/environments/env_1/files/a.diff");
  expect(
    patchFileUrl("/tmp/a.diff", {
      kind: "host",
      threadId: "thr_a",
      environmentId: null,
      projectId: null,
    }),
  ).toBe("/api/v1/threads/thr_a/host-files/tmp/a.diff");
});

test("a multi-commit patch draws a card per file under each commit's subject", async () => {
  const fetch = open(readFileSync(join(FIXTURES, "format-patch-two-commits.patch"), "utf8"));
  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/threads/thr_a/thread-storage/files/work/change.patch",
    expect.objectContaining({ credentials: "same-origin" }),
  );
  await screen.findByTestId("sc-patch-file");
  const cards = await screen.findAllByTestId("sc-file-card");
  expect(cards.map((card) => card.getAttribute("data-path"))).toEqual([
    "added.ts",
    "dir with space/after.md",
    "gone.txt",
    "keep.txt",
    "keep.txt",
    "logo.png",
  ]);
  expect(screen.getByText("Rework files: rename, add, delete")).toBeTruthy();
  expect(screen.getByText("Add logo and a fourth line")).toBeTruthy();
  expect(screen.getByTestId("sc-patch-file").textContent).toContain("2 commits · 6 files");
  expect(screen.queryByTestId("bb-original")).toBeNull();
});

test("Open as text shows BB's preview, and Show diff comes back", async () => {
  open("--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n");
  fireEvent.click(await screen.findByRole("button", { name: "Open as text" }));
  expect(screen.getByTestId("bb-original")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show diff" }));
  await screen.findByTestId("sc-patch-file");
  expect(screen.queryByTestId("bb-original")).toBeNull();
});

test.each([
  ["text with no diff", () => open("Just some notes.\nNothing to see.\n")],
  ["a failed read", () => open("missing", { status: 404 })],
  [
    "a file too large to read whole",
    () => open("x", { headers: { "content-length": String(MAX_PATCH_BYTES + 1) } }),
  ],
])("%s falls back to BB's text preview", async (_, start) => {
  start();
  await waitFor(() => expect(screen.getByTestId("bb-original")).toBeTruthy());
  expect(screen.queryByTestId("sc-patch-file")).toBeNull();
});
