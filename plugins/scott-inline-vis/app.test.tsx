// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StrictMode, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot as sdkRenderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  widgetIdentitySchema,
  saveWidgetStateSchema,
  type WidgetStateSnapshot,
  type WidgetIdentity,
} from "./state-contract.ts";

const snapshots = new Map<string, WidgetStateSnapshot>();
const identityKey = (identity: WidgetIdentity) =>
  JSON.stringify([identity.threadId, identity.messageId, identity.file]);
const stateRpc = {
  readState: (raw: unknown) => snapshots.get(identityKey(widgetIdentitySchema.parse(raw))) ?? null,
  saveState: (raw: unknown) => {
    const input = saveWidgetStateSchema.parse(raw);
    const existing = snapshots.get(identityKey(input));
    const { fields, ifMissing, ...data } = input;
    if (ifMissing && existing && existing.hasWidgetState !== false) return existing;
    if (!ifMissing && fields?.length === 0) {
      if (!existing) throw new Error("No visualization state has been saved yet.");
      return existing;
    }
    const writeState = ifMissing === true || fields === undefined || fields.includes("state");
    const writeTweaks = !ifMissing && (fields === undefined || fields.includes("tweaks"));
    const result = {
      threadId: data.threadId,
      messageId: data.messageId,
      file: data.file,
      state: "null",
      modelContent: null as string | null,
      tweaks: data.tweaks ?? null,
      hasWidgetState: false as boolean | null,
      ...existing,
      savedAt: "2026-09-30T22:00:00.000Z",
      mentionId: identityKey(input),
    };
    if (writeState) {
      result.state = data.state!;
      result.modelContent = data.modelContent ?? null;
      result.hasWidgetState = true;
    }
    if (writeTweaks) result.tweaks = data.tweaks ?? null;
    snapshots.set(identityKey(input), result);
    return result;
  },
};
const renderSlot: typeof sdkRenderSlot = (registration, props, options) =>
  sdkRenderSlot(registration, props, { ...options, rpc: { ...stateRpc, ...options?.rpc } });

for (const method of ["show", "showModal", "close"] as const) {
  Object.defineProperty(HTMLDialogElement.prototype, method, {
    configurable: true,
    value(this: HTMLDialogElement) {
      if (method === "close") this.removeAttribute("open");
      else this.setAttribute("open", "");
    },
  });
}

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
  snapshots.clear();
  Reflect.deleteProperty(navigator, "userActivation");
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
  expect(markdown.closest("figure")).toBe(loadingCard);
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

test("inline-vis loads a full HTML document from the SDK preview URL with an opaque-origin sandbox", async () => {
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
    { sdk: previewSdk(() => "<!doctype html><h1>Example</h1>") },
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
  expect(iframe.closest("figure")).toBe(loadingCard);
  expect(loadingCard.firstElementChild?.className).toBe(loadingHeader.className);
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

async function renderFragment(
  html: string,
  {
    height,
    composerText,
    messageId = inlineVisMessage.id,
    rpc,
  }: {
    height?: string;
    composerText?: string;
    messageId?: string;
    rpc?: NonNullable<Parameters<typeof sdkRenderSlot>[2]>["rpc"];
  } = {},
) {
  const directive = await inlineVisDirective();
  const attributes: Record<string, string> = { file: "/tmp/viz/chart.html" };
  if (height) attributes.height = height;
  const slot = renderSlot(
    directive,
    {
      attributes,
      source: '::inline-vis{file="/tmp/viz/chart.html"}',
      message: { ...inlineVisMessage, id: messageId },
      openWorkspaceFile: null,
    },
    {
      sdk: previewSdk(() => html),
      pluginId: "scott-inline-vis",
      composer: { text: composerText ?? "" },
      rpc,
    },
  );
  const iframe = await waitFor(() => {
    const element = slot.container.querySelector("iframe");
    expect(element?.getAttribute("srcdoc")).toBeTruthy();
    return element as HTMLIFrameElement;
  });
  // The frame listener registers in a passive effect after the srcdoc commit.
  await act(async () => {});
  const srcdoc = iframe.getAttribute("srcdoc")!;
  const token = /"token":"([^"]+)"/u.exec(srcdoc)![1]!;
  const send = (data: Record<string, unknown>) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { token, ...data }, source: iframe.contentWindow }),
      );
    });
  return { slot, iframe, srcdoc, token, send };
}

test("inline-vis renders an HTML fragment inside the visualization runtime", async () => {
  const { slot, iframe, srcdoc } = await renderFragment('<div id="viz" class="card">Hi</div>');

  expect(iframe.getAttribute("src")).toBeNull();
  expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
  const frameDocument = new DOMParser().parseFromString(srcdoc, "text/html");
  expect(frameDocument.querySelector("base")?.getAttribute("href")).toBe(
    "http://localhost:3000/api/v1/file-previews/lease/chart.html",
  );
  expect(frameDocument.querySelector("style")?.textContent).toContain("--viz-series-1");
  expect(frameDocument.querySelector("#viz")?.textContent).toBe("Hi");
  // The runtime script runs before the fragment's own markup and scripts.
  expect(frameDocument.head.querySelector("script")?.textContent).toContain('"bb"');
  slot.unmount();
});

test("inline-vis sizes a fragment to its content within the height limits", async () => {
  const { slot, iframe, send } = await renderFragment("<p>Tall</p>");
  expect(iframe.style.height).toBe("224px");

  send({ type: "bb:inline-vis:resize", height: 318.4 });
  expect(iframe.style.height).toBe("319px");
  send({ type: "bb:inline-vis:resize", height: 9_000 });
  expect(iframe.style.height).toBe("1200px");
  send({ type: "bb:inline-vis:resize", height: 3 });
  expect(iframe.style.height).toBe("40px");
  // A message with the wrong token is ignored.
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "bb:inline-vis:resize", token: "other", height: 500 },
        source: iframe.contentWindow,
      }),
    );
  });
  expect(iframe.style.height).toBe("40px");
  slot.unmount();
});

test("inline-vis sends theme changes when bb rewrites its theme stylesheet", async () => {
  const themeStyle = document.createElement("style");
  themeStyle.textContent = ":root { --background: #111111; }";
  document.head.append(themeStyle);
  const { slot, iframe, token } = await renderFragment("<p>Theme</p>");
  const post = vi.spyOn(iframe.contentWindow!, "postMessage");

  themeStyle.textContent = ":root { --background: #fafafa; }";
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      {
        type: "bb:inline-vis:theme",
        token,
        theme: expect.objectContaining({
          tokens: expect.objectContaining({ "--background": "#fafafa" }),
        }),
      },
      "*",
    ),
  );
  themeStyle.remove();
  slot.unmount();
});

test("inline-vis keeps an explicit fragment height", async () => {
  const { slot, iframe, send } = await renderFragment("<p>Fixed</p>", { height: "480" });
  send({ type: "bb:inline-vis:resize", height: 200 });
  expect(iframe.style.height).toBe("480px");
  slot.unmount();
});

test("inline-vis restores saved fragment state when the preview reopens", async () => {
  const first = await renderFragment("<p>State</p>");
  first.send({ type: "bb:inline-vis:state", state: '{"tab":"latency"}' });
  await waitFor(() => expect([...snapshots.values()][0]?.state).toBe('{"tab":"latency"}'));
  first.slot.unmount();

  const second = await renderFragment("<p>State</p>");
  expect(second.srcdoc).toContain('"state":"{\\"tab\\":\\"latency\\"}"');
  second.slot.unmount();

  const otherMessage = await renderFragment("<p>State</p>", { messageId: "message-other" });
  expect(otherMessage.srcdoc).toContain('"state":null');
  otherMessage.slot.unmount();
});

/** jsdom has no user activation API. Browsers report it on the parent page. */
function setUserActivation(isActive: boolean) {
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: { isActive, hasBeenActive: isActive },
  });
}

test("inline-vis ignores a follow-up prompt without a user click", async () => {
  setUserActivation(false);
  const { slot, send } = await renderFragment("<p>Ask</p>", { composerText: "Draft" });
  send({ type: "bb:inline-vis:follow-up", prompt: "Explain the p99 spike" });

  expect(slot.inspection.composer.text).toBe("Draft");
  expect(slot.inspection.composer.focusCount).toBe(0);
  Reflect.deleteProperty(navigator, "userActivation");
  slot.unmount();
});

test("inline-vis puts a fragment follow-up prompt in the composer", async () => {
  setUserActivation(true);
  const { slot, send } = await renderFragment("<p>Ask</p>", { composerText: "Draft" });
  send({ type: "bb:inline-vis:follow-up", prompt: "  Explain the p99 spike  " });

  await waitFor(() =>
    expect(slot.inspection.composer.text).toContain("Draft\n\nExplain the p99 spike"),
  );
  expect(slot.inspection.composer.focusCount).toBe(1);
  expect(slot.inspection.composer.mentions).toEqual([]);
  slot.unmount();
});

test("wide view preserves the live iframe and returns to chat on Escape", async () => {
  const { slot, iframe, send } = await renderFragment("<p>Wide</p>");
  send({ type: "bb:inline-vis:resize", height: 356 });
  fireEvent.click(slot.getByRole("button", { name: "Wide view" }));
  const dialog = slot.getByRole("dialog", { name: "Wide visualization: /tmp/viz/chart.html" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.querySelector("iframe")).toBe(iframe);
  expect(iframe.style.height).toBe("356px");
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(
    slot
      .getByRole("region", { name: "Visualization: /tmp/viz/chart.html" })
      .querySelector("iframe"),
  ).toBe(iframe);
  expect(document.activeElement).toBe(slot.getByRole("button", { name: "Wide view" }));
  slot.unmount();
});

test("saved state reaches a fresh native mention without exposing it in the draft", async () => {
  const { slot, send } = await renderFragment("<p>State</p>", {
    composerText: "Explain my selection",
  });
  send({
    type: "bb:inline-vis:state",
    state: '{"tab":"latency","internal":8}',
    modelContent: '{"selectedTab":"latency"}',
  });
  fireEvent.click(await slot.findByRole("button", { name: "Use saved state" }));
  await waitFor(() =>
    expect(slot.inspection.composer.mentions).toEqual([
      {
        provider: "widget-state",
        id: '["thread-inline-vis","message-inline-vis","/tmp/viz/chart.html"]',
        label: "State: chart.html",
      },
    ]),
  );
  expect(slot.inspection.composer.text).toContain("Explain my selection");
  expect(slot.inspection.composer.text).not.toContain("internal");
  expect([...snapshots.values()][0]?.modelContent).toBe('{"selectedTab":"latency"}');
  slot.unmount();
});

test("a failed save stays visible and does not attach stale model context", async () => {
  const { slot, send } = await renderFragment("<p>State</p>", {
    composerText: "My draft",
    rpc: {
      saveState: () => {
        throw new Error("Storage unavailable");
      },
    },
  });
  send({ type: "bb:inline-vis:state", state: '{"selected":2}' });
  fireEvent.click(await slot.findByRole("button", { name: "Use saved state" }));
  await waitFor(() => expect(slot.getByRole("alert").textContent).toContain("Storage unavailable"));
  expect(slot.inspection.composer.text).toBe("My draft");
  expect(slot.inspection.composer.mentions).toEqual([]);
  slot.unmount();
});

test("Tweak controls route edits to their frame and keep hidden designs out of the panel", async () => {
  const { slot, iframe, token, send } = await renderFragment("<div id='player'>Player</div>");
  const groups = [
    {
      id: "tweak-player",
      title: "Player",
      variant: "Compact",
      visible: true,
      controls: [
        {
          id: "slider:radius",
          label: "Corner radius",
          type: "slider",
          value: 18,
          initialValue: 18,
          min: 0,
          max: 40,
          step: 1,
          unit: "px",
        },
      ],
    },
    { id: "tweak-hidden", title: "Hidden design", variant: "Studio", visible: false, controls: [] },
  ];
  send({ type: "bb:inline-vis:tweak", groups, original: false, changed: false });
  fireEvent.click(slot.getByRole("button", { name: "Tweak" }));
  const slider = slot.getByRole("slider", { name: "Corner radius" });
  const post = vi.spyOn(iframe.contentWindow!, "postMessage");
  fireEvent.change(slider, { target: { value: "8" } });
  expect(post).toHaveBeenLastCalledWith(
    {
      type: "bb:inline-vis:tweak-change",
      token,
      groupId: "tweak-player",
      controlId: "slider:radius",
      value: 8,
    },
    "*",
  );
  expect(slot.queryByText("Hidden design · Studio")).toBeNull();
  send({
    type: "bb:inline-vis:tweak",
    groups: [{ ...groups[0], controls: [{ ...groups[0]!.controls[0], value: 8 }] }, groups[1]],
    original: false,
    changed: true,
  });
  await waitFor(() =>
    expect(slot.getByRole("button", { name: "Add changes to chat" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
  fireEvent.click(slot.getByRole("button", { name: "Add changes to chat" }));
  await waitFor(() =>
    expect(slot.inspection.composer.text).toContain(
      "Use these design adjustments for the next revision.",
    ),
  );
  expect(JSON.parse([...snapshots.values()][0]!.tweaks!)).toEqual([
    {
      groupId: "tweak-player",
      groupTitle: "Player",
      variant: "Compact",
      controlId: "slider:radius",
      label: "Corner radius",
      type: "slider",
      value: 8,
      initialValue: 18,
      unit: "px",
    },
  ]);
  expect(slot.inspection.composer.mentions[0]?.provider).toBe("widget-state");
  slot.unmount();
});

test("reopening waits for the prior preview's pending save before restoring", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = vi.fn(stateRpc.readState);
  const save = vi.fn(async (input: unknown) => {
    await gate;
    return stateRpc.saveState(input);
  });
  const { slot, send } = await renderFragment("<p>Queued</p>", {
    rpc: { readState: read, saveState: save },
  });
  send({ type: "bb:inline-vis:state", state: '{"radius":7}' });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  fireEvent.click(slot.getByRole("button", { name: "Collapse visualization /tmp/viz/chart.html" }));
  fireEvent.click(slot.getByRole("button", { name: "Expand visualization /tmp/viz/chart.html" }));
  await act(async () => {});
  expect(slot.container.querySelector("iframe")).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
  release();
  await waitFor(() =>
    expect(slot.container.querySelector("iframe")?.getAttribute("srcdoc")).toContain(
      '"state":"{\\"radius\\":7}"',
    ),
  );
  slot.unmount();
});

test("an edit removes previously shared context until current state is added again", async () => {
  let fail = false;
  const { slot, send } = await renderFragment("<p>Shared</p>", {
    rpc: {
      saveState: (input: unknown) => {
        if (fail) throw new Error("Storage unavailable");
        return stateRpc.saveState(input);
      },
    },
  });
  send({ type: "bb:inline-vis:state", state: '{"radius":18}' });
  fireEvent.click(await slot.findByRole("button", { name: "Use saved state" }));
  await waitFor(() => expect(slot.inspection.composer.mentions).toHaveLength(1));
  fail = true;
  send({ type: "bb:inline-vis:state", state: '{"radius":7}' });
  expect(slot.inspection.composer.mentions).toEqual([]);
  await waitFor(() => expect(slot.getByRole("alert").textContent).toContain("Storage unavailable"));
  fail = false;
  fireEvent.click(slot.getByRole("button", { name: "Use saved state" }));
  await waitFor(() => expect(slot.inspection.composer.mentions).toHaveLength(1));
  expect([...snapshots.values()][0]?.state).toBe('{"radius":7}');
  slot.unmount();
});

test("valid legacy state stays available when migration fails and restores on retry", async () => {
  const key =
    "scott-inline-vis.widget-state:thread-inline-vis:message-inline-vis:/tmp/viz/chart.html";
  window.localStorage.setItem(key, '{"selected":"studio"}');
  const slot = renderSlot(
    await inlineVisDirective(),
    {
      attributes: { file: "/tmp/viz/chart.html" },
      source: "fixture",
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    {
      pluginId: "scott-inline-vis",
      sdk: previewSdk(() => "<p>Legacy</p>"),
      rpc: {
        saveState: () => {
          throw new Error("Migration unavailable");
        },
      },
    },
  );
  await waitFor(() =>
    expect(slot.getByRole("alert").textContent).toContain("Migration unavailable"),
  );
  expect(slot.container.querySelector("iframe")).toBeNull();
  expect(window.localStorage.getItem(key)).toBe('{"selected":"studio"}');
  slot.unmount();
  const retried = await renderFragment("<p>Legacy</p>");
  expect(retried.srcdoc).toContain('"state":"{\\"selected\\":\\"studio\\"}"');
  expect(window.localStorage.getItem(key)).toBeNull();
  retried.slot.unmount();
});

test("saved null with model-only content remains shareable after reopening", async () => {
  const first = await renderFragment("<p>Model content</p>");
  first.send({ type: "bb:inline-vis:state", state: "null", modelContent: '{"selected":"studio"}' });
  await waitFor(() =>
    expect([...snapshots.values()][0]?.modelContent).toBe('{"selected":"studio"}'),
  );
  first.slot.unmount();
  const second = await renderFragment("<p>Model content</p>");
  expect(second.slot.getByRole("button", { name: "Use saved state" })).toBeTruthy();
  second.slot.unmount();
});

test("unchanged frame publications preserve an attached context chip", async () => {
  const save = vi.fn(stateRpc.saveState);
  const { slot, send } = await renderFragment("<p>Unchanged</p>", { rpc: { saveState: save } });
  const state = {
    type: "bb:inline-vis:state",
    state: '{"radius":18}',
    modelContent: '{"radius":18}',
  };
  const groups = [
    {
      id: "tweak-player",
      title: "Player",
      variant: null,
      visible: true,
      controls: [
        {
          id: "slider:radius",
          label: "Radius",
          type: "slider",
          value: 18,
          initialValue: 18,
          min: 0,
          max: 40,
          step: 1,
        },
      ],
    },
  ];
  send(state);
  send({ type: "bb:inline-vis:tweak", groups, original: false, changed: false });
  fireEvent.click(await slot.findByRole("button", { name: "Use saved state" }));
  await waitFor(() => expect(slot.inspection.composer.mentions).toHaveLength(1));
  const count = save.mock.calls.length;
  send(state);
  send({ type: "bb:inline-vis:tweak", groups, original: true, changed: false });
  await act(async () => {});
  expect(save).toHaveBeenCalledTimes(count);
  expect(slot.inspection.composer.mentions).toHaveLength(1);
  slot.unmount();
});

test("opening a fragment with no design controls does not create saved state", async () => {
  const save = vi.fn(stateRpc.saveState);
  const { slot, send } = await renderFragment("<p>Read only</p>", { rpc: { saveState: save } });
  send({ type: "bb:inline-vis:tweak", groups: [], original: false, changed: false });
  await act(async () => {});
  expect(save).not.toHaveBeenCalled();
  expect(slot.queryByRole("button", { name: "Use saved state" })).toBeNull();
  slot.unmount();
});

const radiusGroup = (id: string, value: number) => ({
  id,
  title: "Player",
  variant: "Compact",
  visible: true,
  controls: [
    {
      id: "slider:radius",
      label: "Corner radius",
      type: "slider",
      value,
      initialValue: 18,
      min: 0,
      max: 40,
      step: 1,
      unit: "px",
      reference: "Match the card corners",
    },
  ],
});

test("late and partial control registration preserves saved edits and attached context", async () => {
  const first = await renderFragment("<p>Late controls</p>");
  first.send({
    type: "bb:inline-vis:tweak",
    groups: [radiusGroup("player", 7)],
    original: false,
    changed: true,
  });
  await first.slot.findByRole("button", { name: "Use saved state" });
  fireEvent.click(first.slot.getByRole("button", { name: "Use saved state" }));
  await waitFor(() => expect(first.slot.inspection.composer.mentions).toHaveLength(1));
  fireEvent.click(
    first.slot.getByRole("button", { name: "Collapse visualization /tmp/viz/chart.html" }),
  );
  fireEvent.click(
    first.slot.getByRole("button", { name: "Expand visualization /tmp/viz/chart.html" }),
  );
  await waitFor(() => expect(first.slot.container.querySelector("iframe")).toBeTruthy());
  const iframe = first.slot.container.querySelector("iframe")!;
  const token = /"token":"([^"]+)"/u.exec(iframe.srcdoc)![1]!;
  const publish = (groups: unknown[]) =>
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: "bb:inline-vis:tweak", token, groups, original: false, changed: false },
        }),
      ),
    );
  publish([]);
  publish([radiusGroup("other-player", 18)]);
  await waitFor(() => expect(JSON.parse([...snapshots.values()][0]!.tweaks!)).toHaveLength(1));
  expect(JSON.parse([...snapshots.values()][0]!.tweaks!)[0]).toEqual({
    groupId: "player",
    groupTitle: "Player",
    variant: "Compact",
    controlId: "slider:radius",
    label: "Corner radius",
    type: "slider",
    value: 7,
    initialValue: 18,
    unit: "px",
    reference: "Match the card corners",
  });
  expect(first.slot.inspection.composer.mentions).toHaveLength(1);
  publish([radiusGroup("player", 7)]);
  await act(async () => {});
  expect(first.slot.inspection.composer.mentions).toHaveLength(1);
  fireEvent.click(first.slot.getByRole("button", { name: "Tweak" }));
  expect(first.slot.getByText("Match the card corners")).toBeTruthy();
  first.slot.unmount();
});

test("state read failures leave a usable preview without writing defaults and retry restores saved data", async () => {
  let available = false;
  const save = vi.fn(stateRpc.saveState);
  const { slot, send, srcdoc } = await renderFragment("<p>Usable preview</p>", {
    rpc: {
      readState: () => {
        if (!available) throw new Error("State server restarting");
        return {
          ...inlineVisMessage,
          file: "/tmp/viz/chart.html",
          messageId: inlineVisMessage.id,
          state: '{"radius":7}',
          modelContent: null,
          tweaks: null,
          hasWidgetState: true,
          savedAt: "2026-09-30T22:00:00.000Z",
          mentionId: "stored",
        };
      },
      saveState: save,
    },
  });
  expect(srcdoc).toContain("Usable preview");
  expect(slot.getByRole("alert").textContent).toContain("Preview changes will not be saved");
  send({ type: "bb:inline-vis:state", state: '{"radius":18}' });
  send({
    type: "bb:inline-vis:tweak",
    groups: [radiusGroup("player", 18)],
    original: false,
    changed: false,
  });
  await act(async () => {});
  expect(save).not.toHaveBeenCalled();
  expect(slot.queryByRole("button", { name: "Use saved state" })).toBeNull();
  available = true;
  fireEvent.click(slot.getByRole("button", { name: "Retry saved state" }));
  await waitFor(() =>
    expect(slot.container.querySelector("iframe")?.srcdoc).toContain('"state":"{\\"radius\\":7}"'),
  );
  expect(slot.queryByRole("alert")).toBeNull();
  slot.unmount();
});

test("Escape from the authenticated iframe leaves Wide view and restores trigger focus", async () => {
  const { slot, iframe, send } = await renderFragment("<input>");
  const trigger = slot.getByRole("button", { name: "Wide view" });
  fireEvent.click(trigger);
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        data: { type: "bb:inline-vis:escape", token: "wrong" },
      }),
    ),
  );
  expect(slot.queryByRole("dialog")).toBeTruthy();
  send({ type: "bb:inline-vis:escape" });
  expect(slot.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(slot.container.querySelector("iframe")).toBe(iframe);
  slot.unmount();
});

test("prepared full HTML forwards Escape without gaining the fragment state API", async () => {
  const fetchImage = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("image", { headers: { "content-type": "image/png" } }));
  const save = vi.fn(stateRpc.saveState);
  const slot = renderSlot(
    await inlineVisDirective(),
    {
      attributes: { file: "/tmp/full.html" },
      source: "fixture",
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    {
      sdk: previewSdk(() => "<!doctype html><button>Focus</button><img src=photo.png>"),
      rpc: { saveState: save },
    },
  );
  await waitFor(() =>
    expect(slot.container.querySelector("iframe")?.srcdoc).toContain("bb:inline-vis:escape"),
  );
  const iframe = slot.container.querySelector("iframe")!;
  const token = /const token = "([^"]+)"/u.exec(iframe.srcdoc)![1]!;
  await act(async () => {});
  fireEvent.click(slot.getByRole("button", { name: "Wide view" }));
  const send = (data: Record<string, unknown>) =>
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", { source: iframe.contentWindow, data: { token, ...data } }),
      ),
    );
  send({ type: "bb:inline-vis:state", state: '{"radius":18}' });
  expect(save).not.toHaveBeenCalled();
  send({ type: "bb:inline-vis:escape" });
  expect(slot.queryByRole("dialog")).toBeNull();
  expect(slot.container.querySelector("iframe")).toBe(iframe);
  slot.unmount();
  fetchImage.mockRestore();
});

test("a successful tweak save does not hide an unsaved widget-state failure", async () => {
  let failState = true;
  const { slot, send } = await renderFragment("<p>Independent saves</p>", {
    rpc: {
      saveState: (raw: unknown) => {
        const input = saveWidgetStateSchema.parse(raw);
        if (failState && input.fields?.includes("state")) throw new Error("State write failed");
        return stateRpc.saveState(input);
      },
    },
  });
  send({ type: "bb:inline-vis:state", state: '{"selected":"studio"}' });
  await slot.findByRole("alert");
  send({
    type: "bb:inline-vis:tweak",
    groups: [radiusGroup("player", 7)],
    original: false,
    changed: true,
  });
  await waitFor(() => expect([...snapshots.values()][0]?.tweaks).toBeTruthy());
  expect(slot.getByRole("alert").textContent).toContain("State write failed");
  expect([...snapshots.values()][0]?.state).toBe("null");
  failState = false;
  fireEvent.click(slot.getByRole("button", { name: "Use saved state" }));
  await waitFor(() => expect(slot.inspection.composer.mentions).toHaveLength(1));
  expect(slot.queryByRole("alert")).toBeNull();
  expect([...snapshots.values()][0]?.state).toBe('{"selected":"studio"}');
  slot.unmount();
});

test("unsaved widget state keeps its retry action after the last Tweak adjustment resets", async () => {
  let failState = true;
  const { slot, send } = await renderFragment("<p>Independent saves</p>", {
    rpc: {
      saveState: (raw: unknown) => {
        const input = saveWidgetStateSchema.parse(raw);
        if (failState && input.fields?.includes("state")) throw new Error("State write failed");
        return stateRpc.saveState(input);
      },
    },
  });
  send({
    type: "bb:inline-vis:tweak",
    groups: [radiusGroup("player", 7)],
    original: false,
    changed: true,
  });
  await slot.findByRole("button", { name: "Use saved state" });
  send({ type: "bb:inline-vis:state", state: '{"selected":"studio"}' });
  await slot.findByRole("alert");
  send({
    type: "bb:inline-vis:tweak",
    groups: [radiusGroup("player", 18)],
    original: false,
    changed: true,
    reset: null,
  });
  await waitFor(() => expect([...snapshots.values()][0]?.tweaks).toBe("[]"));
  await act(async () => {});
  expect(slot.getByRole("alert").textContent).toContain("State write failed");
  failState = false;
  fireEvent.click(slot.getByRole("button", { name: "Use saved state" }));
  await waitFor(() => expect(slot.inspection.composer.mentions).toHaveLength(1));
  expect([...snapshots.values()][0]?.state).toBe('{"selected":"studio"}');
  expect(slot.queryByRole("alert")).toBeNull();
  slot.unmount();
});

test("Reset all clears saved controls that have not registered yet", async () => {
  const { slot, send } = await renderFragment("<p>Lazy controls</p>");
  send({
    type: "bb:inline-vis:tweak",
    groups: [radiusGroup("player", 7), radiusGroup("lazy-player", 9)],
    original: false,
    changed: true,
  });
  await waitFor(() => expect(JSON.parse([...snapshots.values()][0]!.tweaks!)).toHaveLength(2));
  send({
    type: "bb:inline-vis:tweak",
    groups: [radiusGroup("player", 18)],
    original: false,
    changed: true,
    reset: "player",
  });
  await waitFor(() =>
    expect(JSON.parse([...snapshots.values()][0]!.tweaks!)).toEqual([
      expect.objectContaining({ groupId: "lazy-player", value: 9 }),
    ]),
  );
  send({
    type: "bb:inline-vis:tweak",
    groups: [radiusGroup("player", 18)],
    original: false,
    changed: true,
    reset: null,
  });
  await waitFor(() => expect(JSON.parse([...snapshots.values()][0]!.tweaks!)).toEqual([]));
  slot.unmount();
});

test("follow-up prompts survive failed saves without attaching stale context", async () => {
  setUserActivation(true);
  const { slot, send } = await renderFragment("<button>Discuss</button>", {
    composerText: "Draft",
    rpc: {
      saveState: () => {
        throw new Error("Storage unavailable");
      },
    },
  });
  send({ type: "bb:inline-vis:state", state: '{"selection":7}' });
  fireEvent.click(slot.getByRole("button", { name: "Wide view" }));
  send({ type: "bb:inline-vis:follow-up", prompt: "Explain my selection" });
  await waitFor(() => expect(slot.inspection.composer.text).toBe("Draft\n\nExplain my selection"));
  expect(slot.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(slot.getByRole("alert").textContent).toContain("Storage unavailable"));
  expect(slot.inspection.composer.mentions).toEqual([]);
  expect(slot.inspection.composer.focusCount).toBeGreaterThan(0);
  slot.unmount();
});

test("follow-up prompts survive a read-only preview", async () => {
  setUserActivation(true);
  const save = vi.fn(stateRpc.saveState);
  const { slot, send } = await renderFragment("<button>Discuss</button>", {
    composerText: "Draft",
    rpc: {
      readState: () => {
        throw new Error("Read unavailable");
      },
      saveState: save,
    },
  });
  send({ type: "bb:inline-vis:follow-up", prompt: "Explain this chart" });
  await waitFor(() => expect(slot.inspection.composer.text).toBe("Draft\n\nExplain this chart"));
  expect(slot.inspection.composer.mentions).toEqual([]);
  expect(save).not.toHaveBeenCalled();
  expect(slot.getByRole("alert").textContent).toContain("Saved state is unavailable");
  slot.unmount();
});

test("oversized tweaks leave state saves and follow-up prompts usable", async () => {
  setUserActivation(true);
  const save = vi.fn(stateRpc.saveState);
  const { slot, send } = await renderFragment("<p>Many controls</p>", {
    composerText: "Draft",
    rpc: { saveState: save },
  });
  const groups = Array.from({ length: 8 }, (_, group) => ({
    ...radiusGroup(`player-${group}`, 7),
    controls: Array.from({ length: 8 }, (_, control) => ({
      ...radiusGroup("player", 7).controls[0]!,
      id: `slider:radius-${control}`,
      label: "R".repeat(160),
      reference: "C".repeat(160),
    })),
  }));
  send({ type: "bb:inline-vis:tweak", groups, original: false, changed: true });
  await waitFor(() =>
    expect(slot.getByRole("alert").textContent).toContain("Tweak changes exceed 16 KiB"),
  );
  send({ type: "bb:inline-vis:state", state: '{"selection":7}', modelContent: '{"selected":7}' });
  await waitFor(() => expect([...snapshots.values()][0]?.state).toBe('{"selection":7}'));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      fields: ["state"],
      state: '{"selection":7}',
      modelContent: '{"selected":7}',
    }),
  );
  expect(save.mock.calls[0]![0]).not.toHaveProperty("tweaks");
  expect(slot.getByRole("alert").textContent).toContain("Tweak changes exceed 16 KiB");
  send({ type: "bb:inline-vis:follow-up", prompt: "Explain these controls" });
  await waitFor(() =>
    expect(slot.inspection.composer.text).toBe("Draft\n\nExplain these controls"),
  );
  await act(async () => {});
  expect(slot.inspection.composer.mentions).toEqual([]);
  // Resetting adjustments removes the budget error and makes current context shareable.
  send({ type: "bb:inline-vis:tweak", groups: [], original: false, changed: true, reset: null });
  await waitFor(() => expect(slot.queryByRole("alert")).toBeNull());
  fireEvent.click(slot.getByRole("button", { name: "Use saved state" }));
  await waitFor(() => expect(slot.inspection.composer.mentions).toHaveLength(1));
  expect([...snapshots.values()][0]?.tweaks).toBe("[]");
  slot.unmount();
});

test("reading authoritative server state retires an obsolete legacy key", async () => {
  const legacyKey =
    "scott-inline-vis.widget-state:thread-inline-vis:message-inline-vis:/tmp/viz/chart.html";
  window.localStorage.setItem(legacyKey, '{"selected":"old"}');
  stateRpc.saveState({
    threadId: inlineVisMessage.threadId,
    messageId: inlineVisMessage.id,
    file: "/tmp/viz/chart.html",
    state: '{"selected":"server"}',
    modelContent: null,
    tweaks: null,
  });
  const first = await renderFragment("<p>Existing server state</p>");
  expect(first.srcdoc).toContain('"state":"{\\"selected\\":\\"server\\"}"');
  expect(window.localStorage.getItem(legacyKey)).toBeNull();
  first.slot.unmount();
  const second = await renderFragment("<p>Usable preview</p>", {
    rpc: {
      readState: () => {
        throw new Error("Transient read failure");
      },
    },
  });
  expect(second.srcdoc).toContain("Usable preview");
  expect(second.slot.getByRole("alert").textContent).toContain("Saved state is unavailable");
  second.slot.unmount();
});

test("untouched controls do not create saved context for a follow-up", async () => {
  setUserActivation(true);
  const save = vi.fn(stateRpc.saveState);
  const { slot, send } = await renderFragment("<p>Untouched controls</p>", {
    composerText: "Draft",
    rpc: { saveState: save },
  });
  send({
    type: "bb:inline-vis:tweak",
    groups: [radiusGroup("player", 18)],
    original: false,
    changed: false,
  });
  await act(async () => {});
  expect(save).not.toHaveBeenCalled();
  expect(snapshots.size).toBe(0);
  expect(slot.queryByRole("button", { name: "Use saved state" })).toBeNull();
  send({ type: "bb:inline-vis:follow-up", prompt: "Explain these controls" });
  await waitFor(() =>
    expect(slot.inspection.composer.text).toBe("Draft\n\nExplain these controls"),
  );
  expect(slot.inspection.composer.mentions).toEqual([]);
  expect(save).not.toHaveBeenCalled();
  slot.unmount();
});

test.each([false, null])(
  "an empty persisted Tweak row (%s) does not offer model context",
  async (marker) => {
    setUserActivation(true);
    const identity = {
      threadId: inlineVisMessage.threadId,
      messageId: inlineVisMessage.id,
      file: "/tmp/viz/chart.html",
    };
    const snapshot = stateRpc.saveState({ ...identity, fields: ["tweaks"], tweaks: "[]" });
    snapshots.set(identityKey(identity), { ...snapshot, hasWidgetState: marker });
    const { slot, send } = await renderFragment("<p>Untouched controls</p>");
    expect(slot.queryByRole("button", { name: "Use saved state" })).toBeNull();
    send({ type: "bb:inline-vis:follow-up", prompt: "Explain these controls" });
    await waitFor(() => expect(slot.inspection.composer.text).toBe("Explain these controls"));
    expect(slot.inspection.composer.mentions).toEqual([]);
    slot.unmount();
  },
);

test("a successful field save clears an earlier context-only error", async () => {
  stateRpc.saveState({
    threadId: inlineVisMessage.threadId,
    messageId: inlineVisMessage.id,
    file: "/tmp/viz/chart.html",
    state: '{"selected":1}',
    modelContent: null,
    tweaks: null,
  });
  let failContext = true;
  const { slot, send } = await renderFragment("<p>Context</p>", {
    rpc: {
      saveState: (raw: unknown) => {
        const input = saveWidgetStateSchema.parse(raw);
        if (failContext && input.fields?.length === 0) throw new Error("Transient context failure");
        return stateRpc.saveState(input);
      },
    },
  });
  fireEvent.click(await slot.findByRole("button", { name: "Use saved state" }));
  await waitFor(() =>
    expect(slot.getByRole("alert").textContent).toContain("Transient context failure"),
  );
  failContext = false;
  await act(async () => {
    send({ type: "bb:inline-vis:state", state: '{"selected":2}' });
    fireEvent.click(slot.getByRole("button", { name: "Use saved state" }));
  });
  await waitFor(() => expect(slot.inspection.composer.mentions).toHaveLength(1));
  expect([...snapshots.values()][0]?.state).toBe('{"selected":2}');
  expect(slot.queryByRole("alert")).toBeNull();
  slot.unmount();
});

test("legacy browser state fills a tweaks-only server row without losing adjustments", async () => {
  const legacyKey =
    "scott-inline-vis.widget-state:thread-inline-vis:message-inline-vis:/tmp/viz/chart.html";
  window.localStorage.setItem(legacyKey, '{"selected":"legacy"}');
  const tweaks = '[{"groupId":"player","controlId":"slider:radius","value":7}]';
  stateRpc.saveState({
    threadId: inlineVisMessage.threadId,
    messageId: inlineVisMessage.id,
    file: "/tmp/viz/chart.html",
    fields: ["tweaks"],
    tweaks,
  });
  const { slot, srcdoc } = await renderFragment("<p>Legacy</p>");
  expect(srcdoc).toContain('"state":"{\\"selected\\":\\"legacy\\"}"');
  expect([...snapshots.values()][0]).toMatchObject({
    state: '{"selected":"legacy"}',
    tweaks,
    hasWidgetState: true,
  });
  expect(window.localStorage.getItem(legacyKey)).toBeNull();
  slot.unmount();
});

test("an explicitly saved null state wins over an obsolete browser snapshot", async () => {
  const legacyKey =
    "scott-inline-vis.widget-state:thread-inline-vis:message-inline-vis:/tmp/viz/chart.html";
  window.localStorage.setItem(legacyKey, '{"selected":"legacy"}');
  stateRpc.saveState({
    threadId: inlineVisMessage.threadId,
    messageId: inlineVisMessage.id,
    file: "/tmp/viz/chart.html",
    fields: ["state"],
    state: "null",
    modelContent: null,
  });
  const save = vi.fn(stateRpc.saveState);
  const { slot, srcdoc } = await renderFragment("<p>Cleared state</p>", {
    rpc: { saveState: save },
  });
  expect(srcdoc).toContain('"state":null');
  expect(save).not.toHaveBeenCalled();
  expect(window.localStorage.getItem(legacyKey)).toBeNull();
  slot.unmount();
});

test("an ambiguous old null snapshot retains its browser legacy copy", async () => {
  const legacyKey =
    "scott-inline-vis.widget-state:thread-inline-vis:message-inline-vis:/tmp/viz/chart.html";
  window.localStorage.setItem(legacyKey, '{"selected":"legacy"}');
  const identity = {
    threadId: inlineVisMessage.threadId,
    messageId: inlineVisMessage.id,
    file: "/tmp/viz/chart.html",
  };
  const snapshot = stateRpc.saveState({ ...identity, fields: ["tweaks"], tweaks: "[]" });
  snapshots.set(identityKey(identity), { ...snapshot, hasWidgetState: null });
  const save = vi.fn(stateRpc.saveState);
  const { slot, srcdoc } = await renderFragment("<p>Existing snapshot</p>", {
    rpc: { saveState: save },
  });
  expect(srcdoc).toContain('"state":null');
  expect(save).not.toHaveBeenCalled();
  expect(window.localStorage.getItem(legacyKey)).toBe('{"selected":"legacy"}');
  slot.unmount();
});
