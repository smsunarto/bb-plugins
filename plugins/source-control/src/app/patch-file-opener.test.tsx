// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
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

describe("re-reading the file", () => {
  const file = (name: string) => `--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-a\n+b\n`;
  const paths = () =>
    screen.queryAllByTestId("sc-file-card").map((card) => card.getAttribute("data-path"));
  const opens = () =>
    screen.queryAllByTestId("sc-file-card").map((card) => card.getAttribute("data-open"));
  const tick = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const sentTag = (init: RequestInit) => (init.headers as Record<string, string>)["If-None-Match"];
  const render = () => renderSlot(opener, { path: "work/change.patch", source: STORAGE, Original });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("the same text under a new ETag is downloaded once, then answered 304", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let etag = '"1"';
    const log: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const status = sentTag(init) === etag ? 304 : 200;
        log.push(status);
        return new Response(status === 304 ? null : file("x.txt"), { status, headers: { etag } });
      }),
    );
    render();
    await waitFor(() => expect(paths()).toEqual(["x.txt"]));
    etag = '"2"'; // touched, or saved again with the same bytes
    const from = log.length;
    for (let index = 0; index < 4; index++) await tick(5000);
    expect(log.slice(from)).toEqual([200, 304, 304, 304]);
  });

  test("a failed re-read keeps the diff, says why, and recovers on the next poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let down = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (down) throw new TypeError("Failed to fetch");
        if (sentTag(init) === '"1"') return new Response(null, { status: 304 });
        return new Response(file("x.txt"), { headers: { etag: '"1"' } });
      }),
    );
    render();
    await waitFor(() => expect(paths()).toEqual(["x.txt"]));
    const root = screen.getByTestId("sc-patch-file");
    down = true;
    await tick(5000);
    expect(paths()).toEqual(["x.txt"]);
    expect(screen.getByTestId("sc-patch-file-stale").textContent).toBe(
      "Couldn't re-read: the request didn't reach BB. Showing the last copy read.",
    );
    expect(screen.getByRole("button", { name: "Refresh file" })).toBeTruthy();
    expect(screen.queryByTestId("bb-original")).toBeNull();
    down = false;
    await tick(5000);
    expect(screen.queryByTestId("sc-patch-file-stale")).toBeNull();
    // The same root throughout, so its width observer still follows the panel.
    expect(screen.getByTestId("sc-patch-file")).toBe(root);
  });

  test("a file gone on re-read says so, and the diff stays", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let gone = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        gone
          ? new Response("missing", { status: 404 })
          : new Response(file("x.txt"), { headers: { etag: '"1"' } }),
      ),
    );
    render();
    await waitFor(() => expect(paths()).toEqual(["x.txt"]));
    gone = true;
    await tick(5000);
    expect(screen.getByTestId("sc-patch-file-stale").textContent).toContain(
      "the file is no longer there.",
    );
    expect(paths()).toEqual(["x.txt"]);
  });

  test("a collapsed card stays collapsed on its file when a file is added above it", async () => {
    let body = file("x.txt") + file("y.txt");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    render();
    await waitFor(() => expect(paths()).toEqual(["x.txt", "y.txt"]));
    fireEvent.click(screen.getAllByRole("button", { expanded: true })[0]!);
    body = file("w.txt") + body;
    fireEvent.click(screen.getByRole("button", { name: "Refresh file" }));
    await waitFor(() => expect(paths()).toEqual(["w.txt", "x.txt", "y.txt"]));
    expect(opens()).toEqual(["true", "false", "true"]);
  });

  test("a re-read slower than the poll is left to finish", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let etag = '"1"';
    let body = file("x.txt");
    let started = 0;
    let aborted = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const sent = sentTag(init);
        if (sent === etag) return Promise.resolve(new Response(null, { status: 304 }));
        if (sent === undefined) return Promise.resolve(new Response(body, { headers: { etag } }));
        started++;
        // A changed file over a slow link: the body takes 7 s.
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response(body, { headers: { etag } })), 7000);
          init.signal!.addEventListener("abort", () => {
            clearTimeout(timer);
            aborted++;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }),
    );
    render();
    await waitFor(() => expect(paths()).toEqual(["x.txt"]));
    body += file("y.txt");
    etag = '"2"';
    for (let index = 0; index < 4; index++) await tick(5000);
    expect(paths()).toEqual(["x.txt", "y.txt"]);
    expect({ started, aborted }).toEqual({ started: 1, aborted: 0 });
  });

  test("a 200 KB quoted path draws", async () => {
    const name = "a".repeat(200_000);
    open(`diff --git a/x b/y\nsimilarity index 100%\nrename from "${name}"\nrename to y\n`);
    await waitFor(() => expect(paths()).toEqual(["y"]));
  });
});

test("Shown as text has one Refresh: BB's preview's own", async () => {
  open(readFileSync(join(FIXTURES, "malformed/undercount.patch"), "utf8"));
  await screen.findByTestId("sc-patch-file-notice");
  expect(screen.queryByRole("button", { name: "Refresh file" })).toBeNull();
});

test("a file's diff too large to draw points to Open as text", async () => {
  open(`--- a/m.js\n+++ b/m.js\n@@ -1 +1 @@\n-${"x".repeat(1_600_000)}\n+y\n`);
  const empty = await screen.findByTestId("sc-patch-empty");
  expect(empty.textContent).toBe("This file's diff is too large to draw. Open as text to read it.");
});

describe("review round 3", () => {
  const file = (name: string) => `--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-a\n+b\n`;
  const paths = () =>
    screen.queryAllByTestId("sc-file-card").map((card) => card.getAttribute("data-path"));
  const tick = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const sentTag = (init: RequestInit) => (init.headers as Record<string, string>)["If-None-Match"];
  const render = () => renderSlot(opener, { path: "work/change.patch", source: STORAGE, Original });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a re-read taking 36 s lands, with a notice while it runs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let etag = '"1"';
    let body = file("x.txt");
    let aborted = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const sent = sentTag(init);
        if (sent === etag) return Promise.resolve(new Response(null, { status: 304 }));
        if (sent === undefined) return Promise.resolve(new Response(body, { headers: { etag } }));
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(new Response(body, { headers: { etag } })),
            36_000,
          );
          init.signal!.addEventListener("abort", () => {
            clearTimeout(timer);
            aborted++;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }),
    );
    render();
    await waitFor(() => expect(paths()).toEqual(["x.txt"]));
    body += file("y.txt");
    etag = '"2"';
    await tick(11_000);
    expect(screen.getByTestId("sc-patch-file-stale").textContent).toBe(
      "Reading the file again… Showing the last copy read.",
    );
    for (let index = 0; index < 7; index++) await tick(5000);
    expect(paths()).toEqual(["x.txt", "y.txt"]);
    expect(aborted).toBe(0);
    expect(screen.queryByTestId("sc-patch-file-stale")).toBeNull();
  });

  test("a read that sends nothing for a minute is given up and asked again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        calls++;
        if (calls === 1)
          return Promise.resolve(new Response(file("x.txt"), { headers: { etag: '"1"' } }));
        return new Promise<Response>((_resolve, reject) =>
          init.signal!.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        );
      }),
    );
    render();
    await waitFor(() => expect(paths()).toEqual(["x.txt"]));
    for (let index = 0; index < 14; index++) await tick(5000);
    expect(screen.getByTestId("sc-patch-file-stale").textContent).toBe(
      "Couldn't re-read: BB sent nothing for a minute. Showing the last copy read.",
    );
    expect(calls).toBe(3);
    expect(paths()).toEqual(["x.txt"]);
  });

  test("focus in a card survives a file added above its section", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let etag = '"1"';
    let body = file("x.txt") + file("y.txt");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) =>
        sentTag(init) === etag
          ? new Response(null, { status: 304 })
          : new Response(body, { headers: { etag } }),
      ),
    );
    render();
    await waitFor(() => expect(paths()).toEqual(["x.txt", "y.txt"]));
    const toggle = screen.getAllByRole("button", { expanded: true })[1]!;
    toggle.focus();
    body = file("w.txt") + body;
    etag = '"2"';
    await tick(5000);
    await waitFor(() => expect(paths()).toEqual(["w.txt", "x.txt", "y.txt"]));
    expect(toggle.isConnected).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  test("BB's own Refresh in the text fallback reads the file again", async () => {
    let body = "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    function Preview() {
      return <button type="button">Refresh file</button>;
    }
    renderSlot(opener, { path: "work/change.patch", source: STORAGE, Original: Preview });
    await screen.findByTestId("sc-patch-file-notice");
    body += "+b\n";
    fireEvent.click(screen.getByRole("button", { name: "Refresh file" }));
    await waitFor(() => expect(paths()).toEqual(["x.txt"]));
    expect(screen.queryByTestId("sc-patch-file-notice")).toBeNull();
  });

  test("a click in BB's preview checks the file as a poll would, validators kept", async () => {
    const sent: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(sentTag(init));
        return sentTag(init) === '"1"'
          ? new Response(null, { status: 304 })
          : new Response("--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n", {
              headers: { etag: '"1"' },
            });
      }),
    );
    function Preview() {
      return <button type="button">Copy file contents</button>;
    }
    renderSlot(opener, { path: "work/change.patch", source: STORAGE, Original: Preview });
    await screen.findByTestId("sc-patch-file-notice");
    fireEvent.click(screen.getByRole("button", { name: "Copy file contents" }));
    await waitFor(() => expect(sent).toEqual([undefined, '"1"']));
  });

  test("files named toString and __proto__ open like any other", async () => {
    open(file("toString") + file("__proto__"));
    await waitFor(() => expect(paths()).toEqual(["toString", "__proto__"]));
    const toggles = screen
      .getAllByTestId("sc-file-card")
      .map((card) => card.querySelector("[aria-expanded]")?.getAttribute("aria-expanded"));
    expect(toggles).toEqual(["true", "true"]);
  });
});
