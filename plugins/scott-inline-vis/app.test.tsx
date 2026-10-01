// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StrictMode, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

if (typeof CSSStyleSheet.prototype.replaceSync !== "function") {
  Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", {
    configurable: true,
    value() {},
  });
}
const app = await loadPluginApp(() => import("./app.tsx"));

// Upstream's collapse preference persists per client; each test starts without one.
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

test("registers the inline-vis directive", () => {
  expect(app.messageDirectives.map((directive) => directive.id)).toEqual(["inline-vis"]);
});

test("reserves room for 100 monospace columns without exceeding the message width", async () => {
  const stylesheet = await readFile(join(import.meta.dirname, "app.css"), "utf8");
  expect(stylesheet).toContain("--inline-vis-target-width: calc(100ch + 8rem + 4px)");
  expect(stylesheet).toContain("width: min(var(--inline-vis-target-width), 100%)");
  expect(stylesheet).toContain("max-width: 100%");
});

test("uses the requested preview header background", async () => {
  const stylesheet = await readFile(join(import.meta.dirname, "app.css"), "utf8");
  const header = stylesheet.match(/\.inline-vis-header \{([^}]*)\}/u)?.[1];
  expect(header).toContain("background: #1e1e1e");
});

const inlineVisMessage = {
  id: "message-inline-vis",
  threadId: "thread-inline-vis",
  turnId: "turn-inline-vis",
  projectId: "project-inline-vis",
};

async function inlineVisDirective() {
  const directive = app.messageDirectives.find((item) => item.id === "inline-vis");
  expect(directive).toBeDefined();
  return directive!;
}

type SdkFakes = NonNullable<
  NonNullable<Parameters<typeof import("@get-bb/plugin-sdk/testing/app").renderSlot>[2]>["sdk"]
>;
const LEASE_URL = "/api/v1/file-previews/lease";
/** The host file API as `useSdk()` sees it: `read` returns each file's text. */
function previewSdk(
  read: (path: string) => string | Promise<string>,
  expiresAtMs = Date.now() + 3_600_000,
): SdkFakes {
  return {
    threads: { storageLocation: async () => ({ hostId: "host-1", storageRootPath: "/storage" }) },
    files: {
      read: async ({ path }: { path: string }) => {
        const content = await read(path);
        return { content, contentEncoding: "utf8", sizeBytes: content.length };
      },
      createPreview: async () => ({ baseUrl: LEASE_URL, expiresAtMs }),
    },
  } as unknown as SdkFakes;
}
function previewReads(slot: { sdkCalls: readonly { method: string; args: unknown[] }[] }) {
  return slot.sdkCalls
    .filter((call) => call.method === "files.read")
    .map((call) => (call.args[0] as { path: string }).path);
}

test("inline-vis rejects an unknown source without reading the file", async () => {
  const directive = await inlineVisDirective();
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "/tmp/demo.html", source: "project" },
      source: '::inline-vis{source="project" file="/tmp/demo.html"}',
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    { sdk: {} },
  );

  expect(slot.getByRole("alert").textContent).toMatch(/no longer accepts source/i);
  expect(slot.container.querySelector("iframe")).toBeNull();
  expect(slot.sdkCalls).toEqual([]);
  slot.unmount();
});

test("inline-vis renders workspace Markdown with the host renderer and no iframe", async () => {
  const directive = await inlineVisDirective();
  const openWorkspaceFile = vi.fn(() => true);
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "/tmp/reports/notes.md" },
      source: '::inline-vis{file="/tmp/reports/notes.md"}',
      message: inlineVisMessage,
      openWorkspaceFile,
    },
    { sdk: previewSdk(() => "# Notes\n\nReady for review.") },
  );

  const markdown = await slot.findByTestId("bb-markdown");
  expect(markdown.textContent?.trim()).toBe("# Notes\n\nReady for review.");
  expect(slot.container.querySelector("iframe")).toBeNull();
  expect(markdown.parentElement?.className).toBe("inline-vis-markdown");
  expect(markdown.parentElement?.style.height).toBe("224px");
  expect(slot.getByRole("button", { name: "Open /tmp/reports/notes.md in sidebar" })).toBeTruthy();
  expect(openWorkspaceFile).not.toHaveBeenCalled();
  expect(slot.sdkCalls.map((call) => [call.method, call.args[0]])).toEqual([
    ["threads.storageLocation", { threadId: "thread-inline-vis", signal: expect.any(AbortSignal) }],
    [
      "files.read",
      {
        path: "/tmp/reports/notes.md",
        rootPath: "/tmp/reports",
        hostId: "host-1",
        signal: expect.any(AbortSignal),
      },
    ],
    [
      "files.createPreview",
      {
        rootPath: "/tmp/reports",
        hostId: "host-1",
        ttlMs: 3_600_000,
        signal: expect.any(AbortSignal),
      },
    ],
  ]);
  slot.unmount();
});

test("inline-vis reserves the Markdown preview height while loading", async () => {
  const directive = await inlineVisDirective();
  let resolvePreview = (_content: string) => {};
  const pendingPreview = new Promise<string>((resolve) => {
    resolvePreview = resolve;
  });
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "/tmp/notes.md", height: "480" },
      source: '::inline-vis{file="/tmp/notes.md" height="480"}',
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    { sdk: previewSdk(() => pendingPreview) },
  );

  const loading = await slot.findByRole("status", { name: "Loading visualization /tmp/notes.md" });
  expect((loading as HTMLElement).style.height).toBe("480px");
  const loadingCard = loading.parentElement!;

  resolvePreview("# Notes");
  const markdown = await slot.findByTestId("bb-markdown");
  expect(markdown.parentElement?.style.height).toBe("480px");
  expect(markdown.parentElement?.parentElement).toBe(loadingCard);
  expect(slot.queryByRole("status")).toBeNull();
  slot.unmount();
});

test("inline-vis requires a file attribute without reading the file", async () => {
  const directive = await inlineVisDirective();
  const slot = renderSlot(
    directive,
    {
      attributes: {},
      source: "::inline-vis{}",
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    { sdk: {} },
  );

  expect(slot.getByRole("alert").textContent).toMatch(/requires a file attribute/i);
  expect(slot.sdkCalls).toEqual([]);
  slot.unmount();
});

test("inline-vis uses the SDK preview URL with an opaque-origin script sandbox", async () => {
  const directive = await inlineVisDirective();
  const openWorkspaceFile = vi.fn(() => true);
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "/tmp/charts/demo file.html" },
      source: '::inline-vis{file="/tmp/charts/demo file.html"}',
      message: inlineVisMessage,
      openWorkspaceFile,
    },
    { sdk: previewSdk(() => "<h1>Example</h1>") },
  );

  await slot.findByRole("status", {
    name: "Loading visualization /tmp/charts/demo file.html",
  });
  const iframe = await waitFor(() => {
    const element = slot.container.querySelector("iframe");
    expect(element).toBeTruthy();
    return element as HTMLIFrameElement;
  });

  expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
  expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
  expect(iframe.getAttribute("src")).toBe(`${LEASE_URL}/demo%20file.html`);
  expect(iframe.getAttribute("srcdoc")).toBeNull();
  expect(iframe.style.height).toBe("224px");
  const toggle = slot.getByRole("button", {
    name: "Collapse visualization /tmp/charts/demo file.html",
  });
  const header = toggle.closest(".inline-vis-header")!;
  expect(header.closest(".inline-vis-card")).toBeTruthy();
  expect(toggle.classList.contains("inline-vis-toggle")).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(header.querySelector(".inline-vis-path")?.getAttribute("title")).toBe(
    "/tmp/charts/demo file.html",
  );
  expect(
    slot.getByRole("button", { name: "Open /tmp/charts/demo file.html in sidebar" }),
  ).toBeTruthy();
  expect(openWorkspaceFile).not.toHaveBeenCalled();
  expect(previewReads(slot)).toEqual(["/tmp/charts/demo file.html"]);
  slot.unmount();
});

test("inline-vis sends assets once only to the prepared opaque frame and stops on collapse", async () => {
  const fetchVideo = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("video", { headers: { "content-type": "video/mp4" } }));

  const slot = renderSlot(
    await inlineVisDirective(),
    {
      attributes: { file: "/tmp/charts/player.html" },
      source: '::inline-vis{file="/tmp/charts/player.html"}',
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    { sdk: previewSdk(() => '<video controls src="clip.mp4"></video>') },
  );
  try {
    await waitFor(() =>
      expect(slot.container.querySelector("iframe")?.getAttribute("srcdoc")).toContain(
        "bb:inline-preview-ready",
      ),
    );
    expect(slot.container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
    const iframe = slot.container.querySelector("iframe")!;
    const post = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    const token = iframe.srcdoc.match(/const token = "([^"]+)"/)![1];
    const ready = (source: Window | null, value: string) =>
      window.dispatchEvent(
        new window.MessageEvent("message", {
          source,
          data: { type: "bb:inline-preview-ready", token: value },
        }),
      );
    ready(window, token!);
    ready(iframe.contentWindow, "wrong-token");
    expect(post).not.toHaveBeenCalled();
    ready(iframe.contentWindow, token!);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0].assets[0].blob.type).toBe("video/mp4");
    ready(iframe.contentWindow, token!);
    expect(post).toHaveBeenCalledTimes(1);
    fireEvent.click(
      slot.getByRole("button", { name: "Collapse visualization /tmp/charts/player.html" }),
    );
    expect(slot.container.querySelector("iframe")).toBeNull();
    ready(iframe.contentWindow, token!);
    expect(post).toHaveBeenCalledTimes(1);
    post.mockRestore();
  } finally {
    slot.unmount();
    fetchVideo.mockRestore();
  }
});

test("inline-vis uses an optional bounded height and reserves it while loading", async () => {
  const directive = await inlineVisDirective();
  let resolvePreview = (_html: string) => {};
  const pendingPreview = new Promise<string>((resolve) => {
    resolvePreview = resolve;
  });
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "/tmp/demo.html", height: "480" },
      source: '::inline-vis{file="/tmp/demo.html" height="480"}',
      message: inlineVisMessage,
      openWorkspaceFile: vi.fn(() => true),
    },
    { sdk: previewSdk(() => pendingPreview) },
  );

  const loading = await slot.findByRole("status", { name: "Loading visualization /tmp/demo.html" });
  expect((loading as HTMLElement).style.height).toBe("480px");
  const loadingCard = loading.parentElement!;
  const loadingHeader = loadingCard.firstElementChild!;
  expect(loadingHeader.querySelector(".inline-vis-header")).toBeNull();
  expect(loadingHeader.classList.contains("inline-vis-header")).toBe(true);
  expect(loadingHeader.querySelector(".inline-vis-open")).toBeNull();

  resolvePreview("");
  const iframe = await waitFor(() => {
    const element = slot.container.querySelector("iframe");
    expect(element).toBeTruthy();
    return element as HTMLIFrameElement;
  });
  expect(iframe.style.height).toBe("480px");
  expect(iframe.parentElement).toBe(loadingCard);
  expect(iframe.parentElement?.firstElementChild?.className).toBe(loadingHeader.className);
  slot.unmount();
});

test("inline-vis rejects invalid heights without reading the file", async () => {
  const directive = await inlineVisDirective();
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "/tmp/demo.html", height: "100vh" },
      source: '::inline-vis{file="/tmp/demo.html" height="100vh"}',
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    { sdk: {} },
  );

  expect(slot.getByRole("alert").textContent).toMatch(/whole number from 120 to 1200 pixels/i);
  expect(slot.container.querySelector("iframe")).toBeNull();
  expect(slot.sdkCalls).toEqual([]);
  slot.unmount();
});

test("inline-vis reports read failures without mounting an iframe", async () => {
  const directive = await inlineVisDirective();
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "/tmp/missing.html" },
      source: '::inline-vis{file="/tmp/missing.html"}',
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    {
      sdk: previewSdk(() => {
        throw Object.assign(new Error("missing"), { status: 404 });
      }),
    },
  );

  const alert = await slot.findByRole("alert");
  expect(alert.textContent).toMatch(/Preview file not found: \/tmp\/missing\.html/);
  expect(slot.container.querySelector("iframe")).toBeNull();
  slot.unmount();
});

test("inline-vis opens only the final two occurrences and unloads manually collapsed frames", async () => {
  const directive = await inlineVisDirective();
  const Component = directive.component;
  const slot = renderSlot(
    {
      ...directive,
      component: (props) => (
        <StrictMode>
          {[0, 1, 2, 3].map((id) => (
            <Component key={id} {...props} />
          ))}
        </StrictMode>
      ),
    },
    {
      attributes: { file: "/tmp/same.html" },
      source: '::inline-vis{file="/tmp/same.html"}',
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    { sdk: previewSdk(() => "") },
  );
  await waitFor(() => expect(slot.container.querySelectorAll("iframe")).toHaveLength(2));
  const cards = [...slot.container.querySelectorAll(".inline-vis-card")];
  expect(cards.map((card) => !!card.querySelector("iframe"))).toEqual([false, false, true, true]);
  // StrictMode runs the two open previews' effects twice. Closed previews never prepare.
  expect(previewReads(slot)).toHaveLength(4);
  fireEvent.click(cards[0]!.querySelector("button")!);
  await waitFor(() => expect(slot.container.querySelectorAll("iframe")).toHaveLength(3));
  const iframe = cards[0]!.querySelector("iframe");
  fireEvent.click(cards[0]!.querySelector("button")!);
  expect(cards[0]!.querySelector("iframe")).toBeNull();
  expect(cards[0]!.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(cards[0]!.querySelector("button")!);
  await waitFor(() => expect(cards[0]!.querySelector("iframe")).toBeTruthy());
  expect(cards[0]!.querySelector("iframe")).not.toBe(iframe);
  slot.unmount();
});

test("inline-vis keeps thread-wide order and manual choices when new previews and older history arrive", async () => {
  const directive = await inlineVisDirective();
  const Component = directive.component;
  const slot = renderSlot(
    {
      ...directive,
      component: (props) => {
        const [items, setItems] = useState([1, 2, 3]);
        return (
          <>
            <button onClick={() => setItems([1, 2, 3, 4])}>Append preview</button>
            <button onClick={() => setItems([0, 1, 2, 3, 4])}>Prepend history</button>
            {items.map((id) => (
              <Component
                key={id}
                {...props}
                attributes={{ file: `/tmp/${id}.html` }}
                message={{ ...props.message, id: `message-${id}` }}
              />
            ))}
            <Component
              {...props}
              attributes={{ file: "/tmp/other.html" }}
              message={{ ...props.message, threadId: "another-thread" }}
            />
          </>
        );
      },
    },
    { attributes: {}, source: "fixture", message: inlineVisMessage, openWorkspaceFile: null },
    { sdk: previewSdk(() => "") },
  );
  await waitFor(() => expect(slot.container.querySelectorAll("iframe")).toHaveLength(3));
  expect(previewReads(slot).sort()).toEqual(["/tmp/2.html", "/tmp/3.html", "/tmp/other.html"]);
  fireEvent.click(slot.getByRole("button", { name: "Collapse visualization /tmp/3.html" }));
  // Expanding last leaves the remembered preference open, so new previews still auto-open.
  fireEvent.click(slot.getByRole("button", { name: "Expand visualization /tmp/1.html" }));
  await waitFor(() => expect(slot.container.querySelectorAll("iframe")).toHaveLength(3));
  fireEvent.click(slot.getByRole("button", { name: "Append preview" }));
  await waitFor(() => expect(slot.container.querySelectorAll("iframe")).toHaveLength(3));
  const files = () =>
    [...slot.container.querySelectorAll("iframe")].map((frame) => frame.getAttribute("title"));
  expect(files()).toEqual([
    "inline-vis: /tmp/1.html",
    "inline-vis: /tmp/4.html",
    "inline-vis: /tmp/other.html",
  ]);
  fireEvent.click(slot.getByRole("button", { name: "Prepend history" }));
  await waitFor(() =>
    expect(slot.getByRole("button", { name: "Expand visualization /tmp/0.html" })).toBeTruthy(),
  );
  expect(files()).toEqual([
    "inline-vis: /tmp/1.html",
    "inline-vis: /tmp/4.html",
    "inline-vis: /tmp/other.html",
  ]);
  expect(previewReads(slot)).not.toContain("/tmp/0.html");
  slot.unmount();
});

test("inline-vis ignores a preparation result that arrives after collapse", async () => {
  const directive = await inlineVisDirective();
  let resolvePreview = (_html: string) => {};
  const pending = new Promise<string>((resolve) => {
    resolvePreview = resolve;
  });
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "/tmp/pending.html" },
      source: "fixture",
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    { sdk: previewSdk(() => pending) },
  );
  await slot.findByRole("status", { name: "Loading visualization /tmp/pending.html" });
  fireEvent.click(slot.getByRole("button", { name: "Collapse visualization /tmp/pending.html" }));
  resolvePreview("");
  await waitFor(() =>
    expect(
      slot.getByRole("button", { name: "Expand visualization /tmp/pending.html" }),
    ).toBeTruthy(),
  );
  expect(slot.container.querySelector("iframe")).toBeNull();
  slot.unmount();
});

test("inline-vis remembers the last collapse choice for previews that mount later", async () => {
  const directive = await inlineVisDirective();
  const render = (file: string) =>
    renderSlot(
      directive,
      {
        attributes: { file },
        source: "fixture",
        message: { ...inlineVisMessage, id: file },
        openWorkspaceFile: null,
      },
      { sdk: previewSdk(() => "") },
    );

  const first = render("/tmp/first.html");
  await waitFor(() => expect(first.container.querySelector("iframe")).toBeTruthy());
  fireEvent.click(first.getByRole("button", { name: "Collapse visualization /tmp/first.html" }));
  first.unmount();
  const stored = Object.entries(window.localStorage);
  expect(stored).toHaveLength(1);
  // Keyed by plugin id, so it never shares bb's built-in inline-vis preference.
  expect(stored[0]![0]).toMatch(/^.+\.inline-vis\.collapsed$/u);
  expect(stored[0]![0]).not.toBe("bb.inline-vis.collapsed");
  expect(stored[0]![1]).toBe("true");

  const second = render("/tmp/second.html");
  await waitFor(() =>
    expect(
      second.getByRole("button", { name: "Expand visualization /tmp/second.html" }),
    ).toBeTruthy(),
  );
  expect(second.container.querySelector("iframe")).toBeNull();
  expect(previewReads(second)).toEqual([]);
  fireEvent.click(second.getByRole("button", { name: "Expand visualization /tmp/second.html" }));
  await waitFor(() => expect(second.container.querySelector("iframe")).toBeTruthy());
  second.unmount();

  const third = render("/tmp/third.html");
  await waitFor(() => expect(third.container.querySelector("iframe")).toBeTruthy());
  third.unmount();
});

test("inline-vis keeps an open iframe after its lease expires and refreshes only on reopening", async () => {
  const slot = renderSlot(
    await inlineVisDirective(),
    {
      attributes: { file: "/tmp/interactive.html" },
      source: '::inline-vis{file="/tmp/interactive.html"}',
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    { sdk: previewSdk(() => "<input value='keep me'>", Date.now() - 1) },
  );
  try {
    const iframe = await waitFor(() => {
      const value = slot.container.querySelector("iframe");
      expect(value).toBeTruthy();
      return value!;
    });
    // An expired lease previously scheduled a destructive reload after one second.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(slot.container.querySelector("iframe")).toBe(iframe);
    expect(previewReads(slot)).toHaveLength(1);
    fireEvent.click(
      slot.getByRole("button", { name: "Collapse visualization /tmp/interactive.html" }),
    );
    fireEvent.click(
      slot.getByRole("button", { name: "Expand visualization /tmp/interactive.html" }),
    );
    await waitFor(() => expect(previewReads(slot)).toHaveLength(2));
    await waitFor(() => expect(slot.container.querySelector("iframe")).toBeTruthy());
    expect(slot.container.querySelector("iframe")).not.toBe(iframe);
  } finally {
    slot.unmount();
  }
});
