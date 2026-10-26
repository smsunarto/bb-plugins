// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StrictMode, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { ComposerMention } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot as sdkRenderSlot } from "@get-bb/plugin-sdk/testing/app";
import { PREVIEW_FRAME_SANDBOX } from "../shared/preview-frame.ts";
import {
  widgetIdentitySchema,
  saveWidgetStateSchema,
  type WidgetStateSnapshot,
  type WidgetIdentity,
} from "../shared/state-contract.ts";

const snapshots = new Map<string, WidgetStateSnapshot>();
const identityKey = (identity: WidgetIdentity) =>
  JSON.stringify([identity.threadId, identity.messageId, identity.pageId]);
const stateRpc = {
  readState: (raw: unknown) => ({
    snapshot: snapshots.get(identityKey(widgetIdentitySchema.parse(raw))) ?? null,
  }),
  saveState: (raw: unknown) => {
    const input = saveWidgetStateSchema.parse(raw);
    const existing = snapshots.get(identityKey(input));
    const { fields, ...data } = input;
    if (fields?.length === 0) {
      if (!existing) throw new Error("No visualization state has been saved yet.");
      return existing;
    }
    const writeState = fields === undefined || fields.includes("state");
    const writeTweaks = fields === undefined || fields.includes("tweaks");
    const result = {
      threadId: data.threadId,
      messageId: data.messageId,
      pageId: data.pageId,
      state: "null",
      modelContent: null as string | null,
      tweaks: data.tweaks ?? null,
      hasWidgetState: false as boolean,
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

// The collapse preference persists per client; each test starts without one.
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  snapshots.clear();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "userActivation");
});

test("registers only the html-render directive", () => {
  expect(app.messageDirectives.map((directive) => directive.id)).toEqual(["html-render"]);
  expect(app.codeFenceRenderers).toEqual([]);
});

test("reserves room for 100 monospace columns without exceeding the message width", async () => {
  const stylesheet = await readFile(join(import.meta.dirname, "app.css"), "utf8");
  expect(stylesheet).toContain("--html-page-target-width: calc(100ch + 8rem + 4px)");
  expect(stylesheet).toContain("width: min(var(--html-page-target-width), 100%)");
  expect(stylesheet).toContain("max-width: 100%");
});

test("uses the requested preview header background", async () => {
  const stylesheet = await readFile(join(import.meta.dirname, "app.css"), "utf8");
  const header = stylesheet.match(/\.html-page-header \{([^}]*)\}/u)?.[1];
  expect(header).toContain("background: #1e1e1e");
});

const pageMessage = {
  id: "message-html",
  threadId: "thread-html",
  turnId: "turn-html",
  projectId: "project-html",
};

const pageDirective = () => app.messageDirectives.find((item) => item.id === "html-render")!;

/** Directive props for a published page; its title labels the card. */
function pageProps(id: string, title: string, message = pageMessage) {
  return {
    attributes: { id, title, height: "240" },
    source: `::html-render{id="${id}" title="${title}" height="240"}`,
    message,
    openWorkspaceFile: null,
  };
}

/** Serve published pages through `fetch`, recording which page ids loaded. */
function servePages(read: (id: string) => string | Promise<string>) {
  const reads: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const id = new URL(String(input), "http://localhost").searchParams.get("id")!;
    reads.push(id);
    return new Response(await read(id));
  });
  return reads;
}

/** The draft's plugin pills, as `useComposer().draft` reports them. */
function statePills(slot: ReturnType<typeof renderSlot>) {
  return slot.inspection.composer.draft.mentions.flatMap((mention) =>
    mention.kind === "plugin"
      ? [{ provider: mention.provider, id: mention.id, label: mention.label }]
      : [],
  );
}

async function shareSavedState(slot: ReturnType<typeof renderSlot>) {
  const button = await slot.findByRole("button", { name: "Use saved state" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  fireEvent.click(button);
}

const FRAME_URL = "/api/v1/plugins/html/http/frame";
const CHART_ID = "page_chart_0000000001";
/** Request the prepared document the way the frame page does once it loads. */
function frameDocument(iframe: HTMLIFrameElement | null | undefined): string | undefined {
  const frameWindow = iframe?.contentWindow;
  if (!frameWindow) return undefined;
  let html: string | undefined;
  const post = vi.spyOn(frameWindow, "postMessage").mockImplementation((data) => {
    if (data?.type === "bb:html:document") html = data.html;
  });
  try {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frameWindow,
        data: { type: "bb:html:frame-ready" },
      }),
    );
  } finally {
    post.mockRestore();
  }
  return html;
}
test("a failed preview can retry loading without collapsing the card", async () => {
  let available = false;
  servePages(() => {
    if (!available) throw new Error("Server disconnected");
    return "<p>Server reconnected</p>";
  });
  const slot = renderSlot(pageDirective(), pageProps("page_retry_000000001", "Retry"), {
    pluginId: "html",
  });
  expect((await slot.findByRole("alert")).textContent).toContain("Server disconnected");
  available = true;
  fireEvent.click(slot.getByRole("button", { name: "Retry preview" }));
  await waitFor(() =>
    expect(frameDocument(slot.container.querySelector("iframe"))).toContain("Server reconnected"),
  );
  expect(slot.queryByRole("alert")).toBeNull();
  expect(slot.getByRole("button", { name: "Wide view" }).getAttribute("title")).toBe("Wide view");
  slot.unmount();
});

test("inline sharing is disabled while state is saving", async () => {
  let release!: () => void;
  let writes = 0;
  const { slot, send } = await renderFragment("<p>Selection</p>", {
    rpc: {
      saveState: async (input: unknown) => {
        if (++writes === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return stateRpc.saveState(input);
      },
    },
  });
  send({ type: "bb:html:state", state: '{"selected":2}' });
  await waitFor(() => expect(release).toBeTypeOf("function"));
  const share = slot.getByRole("button", { name: "Use saved state" });
  expect(share.hasAttribute("disabled")).toBe(true);
  await act(async () => {
    release();
  });
  await waitFor(() => expect(share.hasAttribute("disabled")).toBe(false));
  fireEvent.click(share);
  await waitFor(() =>
    expect(statePills(slot)).toEqual([
      {
        provider: "widget-state",
        id: '["thread-html","message-html","page_chart_0000000001"]',
        label: "State: Chart",
      },
    ]),
  );
  slot.unmount();
});

test("opens only the final two occurrences and unloads manually collapsed frames", async () => {
  const reads = servePages(() => "");
  const directive = pageDirective();
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
    pageProps("page_same_0000000001", "Same"),
    { pluginId: "html" },
  );
  await waitFor(() => expect(slot.container.querySelectorAll("iframe")).toHaveLength(2));
  const cards = [...slot.container.querySelectorAll(".html-page-card")];
  expect(cards.map((card) => !!card.querySelector("iframe"))).toEqual([false, false, true, true]);
  // StrictMode runs the two open previews' effects twice. Closed previews never prepare.
  expect(reads).toHaveLength(4);
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

test("keeps thread-wide order and manual choices when new previews and older history arrive", async () => {
  const reads = servePages(() => "");
  const directive = pageDirective();
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
                attributes={{ id: `page_${id}_000000000000`, title: `Page ${id}`, height: "240" }}
                message={{ ...props.message, id: `message-${id}` }}
              />
            ))}
            <Component
              {...props}
              attributes={{ id: "page_other_00000000", title: "Other", height: "240" }}
              message={{ ...props.message, threadId: "another-thread" }}
            />
          </>
        );
      },
    },
    { attributes: {}, source: "fixture", message: pageMessage, openWorkspaceFile: null },
    { pluginId: "html" },
  );
  await waitFor(() => expect(slot.container.querySelectorAll("iframe")).toHaveLength(3));
  expect(reads.sort()).toEqual([
    "page_2_000000000000",
    "page_3_000000000000",
    "page_other_00000000",
  ]);
  fireEvent.click(slot.getByRole("button", { name: "Collapse visualization Page 3" }));
  // Expanding last leaves the remembered preference open, so new previews still auto-open.
  fireEvent.click(slot.getByRole("button", { name: "Expand visualization Page 1" }));
  await waitFor(() => expect(slot.container.querySelectorAll("iframe")).toHaveLength(3));
  fireEvent.click(slot.getByRole("button", { name: "Append preview" }));
  await waitFor(() => expect(slot.container.querySelectorAll("iframe")).toHaveLength(3));
  const titles = () =>
    [...slot.container.querySelectorAll("iframe")].map((frame) => frame.getAttribute("title"));
  expect(titles()).toEqual(["HTML: Page 1", "HTML: Page 4", "HTML: Other"]);
  fireEvent.click(slot.getByRole("button", { name: "Prepend history" }));
  await waitFor(() =>
    expect(slot.getByRole("button", { name: "Expand visualization Page 0" })).toBeTruthy(),
  );
  expect(titles()).toEqual(["HTML: Page 1", "HTML: Page 4", "HTML: Other"]);
  expect(reads).not.toContain("page_0_000000000000");
  slot.unmount();
});

test("ignores a page that arrives after collapse", async () => {
  let resolvePreview = (_html: string) => {};
  const pending = new Promise<string>((resolve) => {
    resolvePreview = resolve;
  });
  servePages(() => pending);
  const slot = renderSlot(pageDirective(), pageProps("page_pending_0000001", "Pending"), {
    pluginId: "html",
  });
  await slot.findByRole("status", { name: "Loading visualization Pending" });
  fireEvent.click(slot.getByRole("button", { name: "Collapse visualization Pending" }));
  resolvePreview("");
  await waitFor(() =>
    expect(slot.getByRole("button", { name: "Expand visualization Pending" })).toBeTruthy(),
  );
  expect(slot.container.querySelector("iframe")).toBeNull();
  slot.unmount();
});

test("remembers the last collapse choice for previews that mount later", async () => {
  const reads = servePages(() => "");
  const render = (title: string) =>
    renderSlot(
      pageDirective(),
      pageProps(`page_${title}_0000000000`, title, { ...pageMessage, id: title }),
      { pluginId: "html" },
    );

  const first = render("first");
  await waitFor(() => expect(first.container.querySelector("iframe")).toBeTruthy());
  fireEvent.click(first.getByRole("button", { name: "Collapse visualization first" }));
  first.unmount();
  const stored = Object.entries(window.localStorage).filter(([key]) => key.endsWith(".collapsed"));
  expect(stored).toEqual([["html.collapsed", "true"]]);

  const second = render("second");
  await waitFor(() =>
    expect(second.getByRole("button", { name: "Expand visualization second" })).toBeTruthy(),
  );
  expect(second.container.querySelector("iframe")).toBeNull();
  expect(reads).toEqual(["page_first_0000000000"]);
  fireEvent.click(second.getByRole("button", { name: "Expand visualization second" }));
  await waitFor(() => expect(second.container.querySelector("iframe")).toBeTruthy());
  second.unmount();

  const third = render("third");
  await waitFor(() => expect(third.container.querySelector("iframe")).toBeTruthy());
  third.unmount();
});

/** Deliver the slot's prepared frame document and wire messages from that frame. */
async function connectFrame(slot: ReturnType<typeof renderSlot>) {
  // The app answers the frame page's request once, so keep the delivered document.
  const { iframe, html } = await waitFor(() => {
    const element = slot.container.querySelector("iframe");
    const delivered = frameDocument(element);
    expect(delivered).toBeTruthy();
    return { iframe: element as HTMLIFrameElement, html: delivered! };
  });
  // The frame listener registers in a passive effect after the frame commit.
  await act(async () => {});
  const token = /"token":"([^"]+)"/u.exec(html)![1]!;
  const send = (data: Record<string, unknown>) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { token, ...data }, source: iframe.contentWindow }),
      );
    });
  return { slot, iframe, html, token, send };
}

async function renderFragment(
  fragment: string,
  {
    composerText,
    composerMentions,
    messageId = pageMessage.id,
    rpc,
  }: {
    composerText?: string;
    composerMentions?: readonly ComposerMention[];
    messageId?: string;
    rpc?: NonNullable<Parameters<typeof sdkRenderSlot>[2]>["rpc"];
  } = {},
) {
  servePages(() => fragment);
  const slot = renderSlot(
    pageDirective(),
    pageProps(CHART_ID, "Chart", { ...pageMessage, id: messageId }),
    {
      pluginId: "html",
      composer: { text: composerText ?? "", mentions: composerMentions },
      rpc,
    },
  );
  return connectFrame(slot);
}

test("renders a published fragment inside the visualization runtime", async () => {
  const { slot, iframe, html } = await renderFragment('<div id="viz" class="card">Hi</div>');

  // bb mobile cancels about:srcdoc frames, so the document loads through a same-origin page.
  expect(iframe.getAttribute("src")).toBe(FRAME_URL);
  expect(iframe.getAttribute("srcdoc")).toBeNull();
  expect(iframe.getAttribute("sandbox")).toBe(PREVIEW_FRAME_SANDBOX);
  expect(iframe.getAttribute("allow")).toBe("fullscreen");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  expect(parsed.querySelector("style")?.textContent).toContain("--viz-series-1");
  expect(parsed.querySelector("#viz")?.textContent).toBe("Hi");
  // The runtime script runs before the fragment's own markup and scripts.
  expect(parsed.head.querySelector("script")?.textContent).toContain('"bb"');
  slot.unmount();
});

test("answers each frame once and replaces a frame that asks again", async () => {
  const { slot, iframe, html } = await renderFragment("<p>Secret state</p>");
  expect(html).toContain("Secret state");
  // A reload, or a page a preview link navigated to, asks from the same window.
  let again: string | undefined;
  act(() => {
    again = frameDocument(iframe);
  });
  expect(again).toBeUndefined();
  const fresh = slot.container.querySelector("iframe")!;
  expect(fresh).not.toBe(iframe);
  expect(fresh.getAttribute("src")).toBe(FRAME_URL);
  let reloaded: string | undefined;
  act(() => {
    reloaded = frameDocument(fresh);
  });
  expect(reloaded).toBe(html);
  slot.unmount();
});

test("sizes a fragment to its content within the page height limits", async () => {
  const { slot, iframe, send } = await renderFragment("<p>Tall</p>");
  expect(iframe.style.height).toBe("240px");

  send({ type: "bb:html:resize", height: 318.4 });
  expect(iframe.style.height).toBe("319px");
  send({ type: "bb:html:resize", height: 90_000 });
  expect(iframe.style.height).toBe("20000px");
  send({ type: "bb:html:resize", height: 3 });
  expect(iframe.style.height).toBe("80px");
  // A message with the wrong token is ignored.
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "bb:html:resize", token: "other", height: 500 },
        source: iframe.contentWindow,
      }),
    );
  });
  expect(iframe.style.height).toBe("80px");
  slot.unmount();
});

test("reopens a fragment at its last height", async () => {
  const first = await renderFragment("<p>Recording</p>");
  first.send({ type: "bb:html:resize", height: 452 });
  // Unmounting saves the height without waiting for the save delay.
  first.slot.unmount();

  const second = await renderFragment("<p>Recording</p>");
  expect(second.iframe.style.height).toBe("452px");
  second.slot.unmount();

  // Each message keeps its own height.
  const other = await renderFragment("<p>Recording</p>", { messageId: "message-other" });
  expect(other.iframe.style.height).toBe("240px");
  other.slot.unmount();
});

test("sends theme changes when bb rewrites its theme stylesheet", async () => {
  const themeStyle = document.createElement("style");
  themeStyle.textContent = ":root { --background: #111111; }";
  document.head.append(themeStyle);
  const { slot, iframe, token } = await renderFragment("<p>Theme</p>");
  const post = vi.spyOn(iframe.contentWindow!, "postMessage");

  themeStyle.textContent = ":root { --background: #fafafa; }";
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      {
        type: "bb:html:theme",
        token,
        theme: expect.objectContaining({
          variables: expect.objectContaining({ "--background": "#fafafa" }),
        }),
      },
      "*",
    ),
  );
  themeStyle.remove();
  slot.unmount();
});

test("restores saved fragment state when the preview reopens", async () => {
  const first = await renderFragment("<p>State</p>");
  first.send({ type: "bb:html:state", state: '{"tab":"latency"}' });
  await waitFor(() => expect([...snapshots.values()][0]?.state).toBe('{"tab":"latency"}'));
  first.slot.unmount();

  const second = await renderFragment("<p>State</p>");
  expect(second.html).toContain('"state":"{\\"tab\\":\\"latency\\"}"');
  second.slot.unmount();

  const otherMessage = await renderFragment("<p>State</p>", { messageId: "message-other" });
  expect(otherMessage.html).toContain('"state":null');
  otherMessage.slot.unmount();
});

/** jsdom has no user activation API. Browsers report it on the parent page. */
function setUserActivation(isActive: boolean) {
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: { isActive, hasBeenActive: isActive },
  });
}

test("ignores a follow-up prompt without a user click", async () => {
  setUserActivation(false);
  const { slot, send } = await renderFragment("<p>Ask</p>", { composerText: "Draft" });
  send({ type: "bb:html:follow-up", prompt: "Explain the p99 spike" });

  expect(slot.inspection.composer.text).toBe("Draft");
  expect(slot.inspection.composer.focusCount).toBe(0);
  Reflect.deleteProperty(navigator, "userActivation");
  slot.unmount();
});

test("puts a fragment follow-up prompt in the composer", async () => {
  setUserActivation(true);
  const { slot, send } = await renderFragment("<p>Ask</p>", { composerText: "Draft" });
  send({ type: "bb:html:follow-up", prompt: "  Explain the p99 spike  " });

  await waitFor(() =>
    expect(slot.inspection.composer.text).toContain("Draft\n\nExplain the p99 spike"),
  );
  expect(slot.inspection.composer.focusCount).toBe(1);
  expect(statePills(slot)).toEqual([]);
  slot.unmount();
});

test("a preview without design actions sits directly under the header, which holds Wide view", async () => {
  const { slot, iframe } = await renderFragment("<p>Recording</p>");
  const header = slot.container.querySelector("figcaption")!;
  expect(header.contains(slot.getByRole("button", { name: "Wide view" }))).toBe(true);
  expect(slot.container.querySelector(".html-page-toolbar")).toBeNull();
  expect(slot.queryByRole("button", { name: "Tweak" })).toBeNull();
  expect(iframe.closest("figure")).toBe(header.parentElement);
  slot.unmount();
});

test("wide view preserves the live iframe and returns to chat on Escape", async () => {
  const { slot, iframe, send } = await renderFragment("<p>Wide</p>");
  send({ type: "bb:html:resize", height: 356 });
  fireEvent.click(slot.getByRole("button", { name: "Wide view" }));
  const dialog = slot.getByRole("dialog", { name: "Wide visualization: Chart" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.querySelector("iframe")).toBe(iframe);
  expect(iframe.style.height).toBe("356px");
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(slot.getByRole("region", { name: "Visualization: Chart" }).querySelector("iframe")).toBe(
    iframe,
  );
  expect(document.activeElement).toBe(slot.getByRole("button", { name: "Wide view" }));
  slot.unmount();
});

test("saved state reaches a fresh native mention without exposing it in the draft", async () => {
  const { slot, send } = await renderFragment("<p>State</p>", {
    composerText: "Explain my selection",
  });
  send({
    type: "bb:html:state",
    state: '{"tab":"latency","internal":8}',
    modelContent: '{"selectedTab":"latency"}',
  });
  await shareSavedState(slot);
  await waitFor(() =>
    expect(statePills(slot)).toEqual([
      {
        provider: "widget-state",
        id: '["thread-html","message-html","page_chart_0000000001"]',
        label: "State: Chart",
      },
    ]),
  );
  // The pill follows the draft after a space, and a trailing space keeps typing apart from it.
  expect(slot.inspection.composer.text).toBe("Explain my selection @State: Chart ");
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
  send({ type: "bb:html:state", state: '{"selected":2}' });
  await shareSavedState(slot);
  await waitFor(() => expect(slot.getByRole("alert").textContent).toContain("Storage unavailable"));
  expect(slot.inspection.composer.text).toBe("My draft");
  expect(statePills(slot)).toEqual([]);
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
          reference: "Match the card corners",
        },
      ],
    },
    { id: "tweak-hidden", title: "Hidden design", variant: "Studio", visible: false, controls: [] },
  ];
  send({ type: "bb:html:tweak", groups, original: false, changed: false });
  fireEvent.click(slot.getByRole("button", { name: "Tweak" }));
  const slider = slot.getByRole("slider", { name: "Corner radius" });
  expect(slider.getAttribute("aria-valuetext")).toBe("18px");
  expect(document.getElementById(slider.getAttribute("aria-describedby")!)?.textContent).toBe(
    "Match the card corners",
  );
  const post = vi.spyOn(iframe.contentWindow!, "postMessage");
  fireEvent.change(slider, { target: { value: "8" } });
  expect(post).toHaveBeenLastCalledWith(
    {
      type: "bb:html:tweak-change",
      token,
      groupId: "tweak-player",
      controlId: "slider:radius",
      value: 8,
    },
    "*",
  );
  expect(slot.queryByText("Hidden design · Studio")).toBeNull();
  send({
    type: "bb:html:tweak",
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
      reference: "Match the card corners",
    },
  ]);
  expect(statePills(slot)[0]?.provider).toBe("widget-state");
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
  send({ type: "bb:html:state", state: '{"radius":7}' });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  fireEvent.click(slot.getByRole("button", { name: "Collapse visualization Chart" }));
  fireEvent.click(slot.getByRole("button", { name: "Expand visualization Chart" }));
  await act(async () => {});
  expect(slot.container.querySelector("iframe")).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
  release();
  await waitFor(() =>
    expect(frameDocument(slot.container.querySelector("iframe"))).toContain(
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
  send({ type: "bb:html:state", state: '{"radius":18}' });
  await shareSavedState(slot);
  await waitFor(() => expect(statePills(slot)).toHaveLength(1));
  fail = true;
  send({ type: "bb:html:state", state: '{"radius":7}' });
  expect(statePills(slot)).toEqual([]);
  await waitFor(() => expect(slot.getByRole("alert").textContent).toContain("Storage unavailable"));
  fail = false;
  await shareSavedState(slot);
  await waitFor(() => expect(statePills(slot)).toHaveLength(1));
  expect([...snapshots.values()][0]?.state).toBe('{"radius":7}');
  slot.unmount();
});

test("an edit removes only its own pill and keeps later pills on their text", async () => {
  const identity = {
    threadId: pageMessage.threadId,
    messageId: pageMessage.id,
    pageId: CHART_ID,
  };
  const { mentionId } = stateRpc.saveState({
    ...identity,
    state: '{"radius":18}',
    modelContent: null,
    tweaks: null,
  });
  // The harness writes a plugin pill as "@" plus its label.
  const pill = (from: number, label: string, provider: string, id: string): ComposerMention => ({
    from,
    to: from + 1 + label.length,
    label,
    kind: "plugin",
    pluginId: "html",
    provider,
    id,
  });
  const { slot, send } = await renderFragment("<p>Shared</p>", {
    composerText: "Compare @State: Chart with @Notes ",
    composerMentions: [
      pill(8, "State: Chart", "widget-state", mentionId),
      pill(27, "Notes", "notes", "notes-1"),
    ],
  });
  send({ type: "bb:html:state", state: '{"radius":7}' });
  expect(slot.inspection.composer.draft.text).toBe("Compare  with @Notes ");
  expect(slot.inspection.composer.draft.mentions).toEqual([pill(14, "Notes", "notes", "notes-1")]);
  slot.unmount();
});

test("saved null with model-only content remains shareable after reopening", async () => {
  const first = await renderFragment("<p>Model content</p>");
  first.send({ type: "bb:html:state", state: "null", modelContent: '{"selected":"studio"}' });
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
    type: "bb:html:state",
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
  send({ type: "bb:html:tweak", groups, original: false, changed: false });
  await shareSavedState(slot);
  await waitFor(() => expect(statePills(slot)).toHaveLength(1));
  const count = save.mock.calls.length;
  send(state);
  send({ type: "bb:html:tweak", groups, original: true, changed: false });
  await act(async () => {});
  expect(save).toHaveBeenCalledTimes(count);
  expect(statePills(slot)).toHaveLength(1);
  slot.unmount();
});

test("opening a fragment with no design controls does not create saved state", async () => {
  const save = vi.fn(stateRpc.saveState);
  const { slot, send } = await renderFragment("<p>Read only</p>", { rpc: { saveState: save } });
  send({ type: "bb:html:tweak", groups: [], original: false, changed: false });
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
    type: "bb:html:tweak",
    groups: [radiusGroup("player", 7)],
    original: false,
    changed: true,
  });
  await first.slot.findByRole("button", { name: "Use saved state" });
  await shareSavedState(first.slot);
  await waitFor(() => expect(statePills(first.slot)).toHaveLength(1));
  fireEvent.click(first.slot.getByRole("button", { name: "Collapse visualization Chart" }));
  fireEvent.click(first.slot.getByRole("button", { name: "Expand visualization Chart" }));
  await waitFor(() => expect(first.slot.container.querySelector("iframe")).toBeTruthy());
  const iframe = first.slot.container.querySelector("iframe")!;
  const token = /"token":"([^"]+)"/u.exec(frameDocument(iframe)!)![1]!;
  const publish = (groups: unknown[]) =>
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: "bb:html:tweak", token, groups, original: false, changed: false },
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
  expect(statePills(first.slot)).toHaveLength(1);
  publish([radiusGroup("player", 7)]);
  await act(async () => {});
  expect(statePills(first.slot)).toHaveLength(1);
  fireEvent.click(first.slot.getByRole("button", { name: "Tweak" }));
  expect(first.slot.getByText("Match the card corners")).toBeTruthy();
  first.slot.unmount();
});

test("state read failures leave a usable preview without writing defaults and retry restores saved data", async () => {
  let available = false;
  const save = vi.fn(stateRpc.saveState);
  const { slot, send, html } = await renderFragment("<p>Usable preview</p>", {
    rpc: {
      readState: () => {
        if (!available) throw new Error("State server restarting");
        return {
          snapshot: {
            ...pageMessage,
            pageId: CHART_ID,
            messageId: pageMessage.id,
            state: '{"radius":7}',
            modelContent: null,
            tweaks: null,
            hasWidgetState: true,
            savedAt: "2026-09-30T22:00:00.000Z",
            mentionId: "stored",
          },
        };
      },
      saveState: save,
    },
  });
  expect(html).toContain("Usable preview");
  expect(slot.getByRole("alert").textContent).toContain("Preview changes will not be saved");
  send({ type: "bb:html:state", state: '{"radius":18}' });
  send({
    type: "bb:html:tweak",
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
    expect(frameDocument(slot.container.querySelector("iframe"))).toContain(
      '"state":"{\\"radius\\":7}"',
    ),
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
        data: { type: "bb:html:escape", token: "wrong" },
      }),
    ),
  );
  expect(slot.queryByRole("dialog")).toBeTruthy();
  send({ type: "bb:html:escape" });
  expect(slot.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(slot.container.querySelector("iframe")).toBe(iframe);
  slot.unmount();
});

test("a published document forwards Escape without gaining the fragment state API", async () => {
  servePages(() => "<!doctype html><button>Focus</button>");
  const save = vi.fn(stateRpc.saveState);
  const slot = renderSlot(pageDirective(), pageProps("page_full_0000000001", "Full"), {
    pluginId: "html",
    rpc: { saveState: save },
  });
  const html = await waitFor(() => {
    const delivered = frameDocument(slot.container.querySelector("iframe"));
    expect(delivered).toContain("bb:html:escape");
    return delivered!;
  });
  const iframe = slot.container.querySelector("iframe")!;
  const token = /token:"([^"]+)"/u.exec(html)![1]!;
  await act(async () => {});
  fireEvent.click(slot.getByRole("button", { name: "Wide view" }));
  const send = (data: Record<string, unknown>) =>
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", { source: iframe.contentWindow, data: { token, ...data } }),
      ),
    );
  send({ type: "bb:html:state", state: '{"radius":18}' });
  expect(save).not.toHaveBeenCalled();
  send({ type: "bb:html:escape" });
  expect(slot.queryByRole("dialog")).toBeNull();
  expect(slot.container.querySelector("iframe")).toBe(iframe);
  slot.unmount();
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
  send({ type: "bb:html:state", state: '{"selected":"studio"}' });
  await slot.findByRole("alert");
  send({
    type: "bb:html:tweak",
    groups: [radiusGroup("player", 7)],
    original: false,
    changed: true,
  });
  await waitFor(() => expect([...snapshots.values()][0]?.tweaks).toBeTruthy());
  expect(slot.getByRole("alert").textContent).toContain("State write failed");
  expect([...snapshots.values()][0]?.state).toBe("null");
  failState = false;
  await shareSavedState(slot);
  await waitFor(() => expect(statePills(slot)).toHaveLength(1));
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
    type: "bb:html:tweak",
    groups: [radiusGroup("player", 7)],
    original: false,
    changed: true,
  });
  await slot.findByRole("button", { name: "Use saved state" });
  send({ type: "bb:html:state", state: '{"selected":"studio"}' });
  await slot.findByRole("alert");
  send({
    type: "bb:html:tweak",
    groups: [radiusGroup("player", 18)],
    original: false,
    changed: true,
    reset: null,
  });
  await waitFor(() => expect([...snapshots.values()][0]?.tweaks).toBe("[]"));
  await act(async () => {});
  expect(slot.getByRole("alert").textContent).toContain("State write failed");
  failState = false;
  await shareSavedState(slot);
  await waitFor(() => expect(statePills(slot)).toHaveLength(1));
  expect([...snapshots.values()][0]?.state).toBe('{"selected":"studio"}');
  expect(slot.queryByRole("alert")).toBeNull();
  slot.unmount();
});

test("Reset all clears saved controls that have not registered yet", async () => {
  const { slot, send } = await renderFragment("<p>Lazy controls</p>");
  send({
    type: "bb:html:tweak",
    groups: [radiusGroup("player", 7), radiusGroup("lazy-player", 9)],
    original: false,
    changed: true,
  });
  await waitFor(() => expect(JSON.parse([...snapshots.values()][0]!.tweaks!)).toHaveLength(2));
  send({
    type: "bb:html:tweak",
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
    type: "bb:html:tweak",
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
  send({ type: "bb:html:state", state: '{"selection":7}' });
  fireEvent.click(slot.getByRole("button", { name: "Wide view" }));
  send({ type: "bb:html:follow-up", prompt: "Explain my selection" });
  await waitFor(() => expect(slot.inspection.composer.text).toBe("Draft\n\nExplain my selection"));
  expect(slot.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(slot.getByRole("alert").textContent).toContain("Storage unavailable"));
  expect(statePills(slot)).toEqual([]);
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
  send({ type: "bb:html:follow-up", prompt: "Explain this chart" });
  await waitFor(() => expect(slot.inspection.composer.text).toBe("Draft\n\nExplain this chart"));
  expect(statePills(slot)).toEqual([]);
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
  send({ type: "bb:html:tweak", groups, original: false, changed: true });
  await waitFor(() =>
    expect(slot.getByRole("alert").textContent).toContain("Tweak changes exceed 16 KiB"),
  );
  send({ type: "bb:html:state", state: '{"selection":7}', modelContent: '{"selected":7}' });
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
  send({ type: "bb:html:follow-up", prompt: "Explain these controls" });
  await waitFor(() =>
    expect(slot.inspection.composer.text).toBe("Draft\n\nExplain these controls"),
  );
  await act(async () => {});
  expect(statePills(slot)).toEqual([]);
  // Resetting adjustments removes the budget error and makes current context shareable.
  send({ type: "bb:html:tweak", groups: [], original: false, changed: true, reset: null });
  await waitFor(() => expect(slot.queryByRole("alert")).toBeNull());
  await shareSavedState(slot);
  await waitFor(() => expect(statePills(slot)).toHaveLength(1));
  expect([...snapshots.values()][0]?.tweaks).toBe("[]");
  slot.unmount();
});

test("untouched controls do not create saved context for a follow-up", async () => {
  setUserActivation(true);
  const save = vi.fn(stateRpc.saveState);
  const { slot, send } = await renderFragment("<p>Untouched controls</p>", {
    composerText: "Draft",
    rpc: { saveState: save },
  });
  send({
    type: "bb:html:tweak",
    groups: [radiusGroup("player", 18)],
    original: false,
    changed: false,
  });
  await act(async () => {});
  expect(save).not.toHaveBeenCalled();
  expect(snapshots.size).toBe(0);
  expect(slot.queryByRole("button", { name: "Use saved state" })).toBeNull();
  send({ type: "bb:html:follow-up", prompt: "Explain these controls" });
  await waitFor(() =>
    expect(slot.inspection.composer.text).toBe("Draft\n\nExplain these controls"),
  );
  expect(statePills(slot)).toEqual([]);
  expect(save).not.toHaveBeenCalled();
  slot.unmount();
});

test.each([false])(
  "an empty persisted Tweak row (%s) does not offer model context",
  async (marker) => {
    setUserActivation(true);
    const identity = {
      threadId: pageMessage.threadId,
      messageId: pageMessage.id,
      pageId: CHART_ID,
    };
    const snapshot = stateRpc.saveState({ ...identity, fields: ["tweaks"], tweaks: "[]" });
    snapshots.set(identityKey(identity), { ...snapshot, hasWidgetState: marker });
    const { slot, send } = await renderFragment("<p>Untouched controls</p>");
    expect(slot.queryByRole("button", { name: "Use saved state" })).toBeNull();
    send({ type: "bb:html:follow-up", prompt: "Explain these controls" });
    await waitFor(() => expect(slot.inspection.composer.text).toBe("Explain these controls"));
    expect(statePills(slot)).toEqual([]);
    slot.unmount();
  },
);

test("a successful field save clears an earlier context-only error", async () => {
  stateRpc.saveState({
    threadId: pageMessage.threadId,
    messageId: pageMessage.id,
    pageId: CHART_ID,
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
  await shareSavedState(slot);
  await waitFor(() =>
    expect(slot.getByRole("alert").textContent).toContain("Transient context failure"),
  );
  failContext = false;
  send({ type: "bb:html:state", state: '{"selected":2}' });
  await shareSavedState(slot);
  await waitFor(() => expect(statePills(slot)).toHaveLength(1));
  expect([...snapshots.values()][0]?.state).toBe('{"selected":2}');
  expect(slot.queryByRole("alert")).toBeNull();
  slot.unmount();
});

const PAGE_ID = "page_latency_budget_01";

/** A page `html_render` published, served by the plugin's page route. */
async function renderPage(html: string, { status = 200 } = {}) {
  const fetchPage = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(html, { status }));
  const directive = app.messageDirectives.find((item) => item.id === "html-render")!;
  const slot = renderSlot(
    directive,
    {
      attributes: { id: PAGE_ID, title: "Latency budget", height: "240" },
      source: `::html-render{id="${PAGE_ID}" title="Latency budget" height="240"}`,
      message: pageMessage,
      openWorkspaceFile: null,
    },
    { pluginId: "html" },
  );
  return { slot, fetchPage };
}

test("html-render frames a published fragment in the runtime and keeps its state by page", async () => {
  const { slot, fetchPage } = await renderPage('<div id="budget">Budget</div>');
  const { iframe, html, send } = await connectFrame(slot);
  expect(fetchPage).toHaveBeenCalledWith(
    `/api/v1/plugins/html/http/page?id=${PAGE_ID}`,
    expect.objectContaining({ credentials: "same-origin" }),
  );
  expect(iframe.getAttribute("src")).toBe(FRAME_URL);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  expect(parsed.querySelector("#budget")?.textContent).toBe("Budget");
  expect(parsed.head.querySelector("script")?.textContent).toContain("ui/open-link");
  expect(slot.getByRole("button", { name: "Collapse visualization Latency budget" })).toBeTruthy();

  send({ type: "bb:html:state", state: '{"budget":120}' });
  await waitFor(() => expect([...snapshots.values()][0]?.pageId).toBe(PAGE_ID));
  // A published page has no viewport units, so it fits its content past 1200px.
  send({ type: "bb:html:resize", height: 3_000 });
  expect(iframe.style.height).toBe("3000px");
  slot.unmount();
  fetchPage.mockRestore();
});

test("html-render gives a published document the page theme, its size, and host links", async () => {
  const { slot, fetchPage } = await renderPage(
    '<!doctype html><html><head><title>Report</title></head><body><a href="https://example.com/">Docs</a></body></html>',
  );
  // Only the Wide-view bridge carries a document's token, so deliver it without `connectFrame`.
  const { iframe, html } = await waitFor(() => {
    const element = slot.container.querySelector("iframe");
    const delivered = frameDocument(element);
    expect(delivered).toBeTruthy();
    return { iframe: element as HTMLIFrameElement, html: delivered! };
  });
  await act(async () => {});
  const parsed = new DOMParser().parseFromString(html, "text/html");
  expect(parsed.getElementById("html-theme")?.textContent).toMatch(/^:root\{color-scheme:/u);
  expect(parsed.getElementById("html-theme")?.textContent).not.toContain("prefers-color-scheme");
  // The document keeps its own markup: no fragment runtime or design system.
  expect(html).not.toContain('"bb"');
  const fromPage = (data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, source: iframe.contentWindow }));
    });
  await fromPage({
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: { height: 900 },
  });
  expect(iframe.style.height).toBe("900px");

  const link = {
    jsonrpc: "2.0",
    id: "html-link-1",
    method: "ui/open-link",
    params: { url: "https://example.com/" },
  };
  // A page script alone cannot open links: the frame must hold focus and activation.
  await fromPage(link);
  expect(slot.inspection.navigateCalls).toEqual([]);
  setUserActivation(true);
  iframe.focus();
  await fromPage(link);
  expect(slot.inspection.navigateCalls).toEqual([
    { method: "openUrl", url: "https://example.com/" },
  ]);
  await fromPage({
    jsonrpc: "2.0",
    method: "html/notifications/open-image",
    params: { src: "data:image/png;base64,AA==", name: "Chart" },
  });
  expect(slot.getByAltText("Chart").getAttribute("src")).toBe("data:image/png;base64,AA==");
  // An unhandled form submission stays in the document instead of navigating the frame.
  expect(html).toContain('addEventListener("submit"');

  // Escape inside the document still reaches the Wide-view token protocol.
  fireEvent.click(slot.getByRole("button", { name: "Wide view" }));
  expect(slot.container.querySelector("dialog")?.getAttribute("aria-modal")).toBe("true");
  const token = /token:"([^"]+)"/u.exec(html)![1]!;
  await fromPage({ type: "bb:html:escape", token });
  expect(slot.container.querySelector("dialog")?.getAttribute("aria-modal")).not.toBe("true");
  slot.unmount();
  fetchPage.mockRestore();
});

test("html-render explains a page that is no longer stored", async () => {
  const { slot, fetchPage } = await renderPage("Page not found", { status: 404 });
  expect((await slot.findByRole("alert")).textContent).toContain("no longer stored");
  slot.unmount();
  fetchPage.mockRestore();
});
