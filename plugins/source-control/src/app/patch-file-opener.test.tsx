// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { MAX_PATCH_BYTES, patchFileUrl, readCapped } from "./patch-file-opener.tsx";

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

function open(body: string | (() => string), init: ResponseInit = {}) {
  const fetch = vi.fn(async () => new Response(typeof body === "string" ? body : body(), init));
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
  // A `.` or `..` segment could aim the GET at another route: the opener shows BB's preview.
  expect(patchFileUrl("notes/../../../thr_b/thread-storage/files/x.patch", STORAGE)).toBeNull();
  expect(patchFileUrl("./x.patch", STORAGE)).toBeNull();
});

test("the byte cap holds on what is read, with no content-length to trust", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent++;
      controller.enqueue(chunk);
    },
  });
  expect(await readCapped(new Response(body), 3 * 1024 * 1024)).toBeNull();
  expect(sent).toBeLessThanOrEqual(5);
  expect(await readCapped(new Response("é ok"), 16)).toBe("é ok");
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
  // Each text change draws its diff; the rename and the binary file say why they have none.
  await waitFor(() => expect(screen.getAllByTestId("sc-patch")).toHaveLength(4));
  expect(screen.getAllByTestId("sc-patch-empty")).toHaveLength(2);
  expect(screen.queryByTestId("bb-original")).toBeNull();
});

test("a malformed patch shows as text, with a line saying why", async () => {
  open(readFileSync(join(FIXTURES, "malformed/undercount.patch"), "utf8"));
  const notice = await screen.findByTestId("sc-patch-file-notice");
  expect(notice.textContent).toBe(
    "Shown as text. Line 9 continues a hunk past the lines its header counts.",
  );
  expect(screen.getByTestId("bb-original")).toBeTruthy();
  expect(screen.queryByTestId("sc-file-card")).toBeNull();
});

test("Refresh reads the file again and draws what changed", async () => {
  let body = "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n";
  open(() => body);
  await waitFor(() => expect(screen.getAllByTestId("sc-file-card")).toHaveLength(1));
  body += "--- a/y.txt\n+++ b/y.txt\n@@ -1 +1 @@\n-a\n+b\n";
  fireEvent.click(screen.getByRole("button", { name: "Refresh file" }));
  await waitFor(() => expect(screen.getAllByTestId("sc-file-card")).toHaveLength(2));
});

test("Open as text shows BB's preview, and Show diff comes back with cards as they were", async () => {
  open(
    "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n--- a/y.txt\n+++ b/y.txt\n@@ -1 +1 @@\n-a\n+b\n",
  );
  const toggles = await screen.findAllByRole("button", { expanded: true });
  fireEvent.click(toggles[0]!);
  fireEvent.click(screen.getByRole("button", { name: "Open as text" }));
  expect(screen.getByTestId("bb-original")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show diff" }));
  expect(screen.queryByTestId("bb-original")).toBeNull();
  const cards = screen.getAllByTestId("sc-file-card");
  expect(cards.map((card) => card.getAttribute("data-open"))).toEqual(["false", "true"]);
});

test.each([
  [
    "text with no diff",
    () => open("Just some notes.\nNothing to see.\n"),
    "This file holds no diff.",
  ],
  ["a failed read", () => open("missing", { status: 404 }), null],
  [
    "a file too large to read whole",
    () => open("x", { headers: { "content-length": String(MAX_PATCH_BYTES + 1) } }),
    "This file is over 8 MB, too large for the diff view.",
  ],
])("%s falls back to BB's text preview", async (_, start, reason) => {
  start();
  await waitFor(() => expect(screen.getByTestId("bb-original")).toBeTruthy());
  expect(screen.queryByTestId("sc-patch-file")).toBeNull();
  expect(screen.queryByTestId("sc-patch-file-notice")?.textContent ?? null).toBe(
    reason === null ? null : `Shown as text. ${reason}`,
  );
});
