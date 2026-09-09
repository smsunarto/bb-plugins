import { expect, mock, spyOn, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import { readFile } from "node:fs/promises";
import { parsePatchFiles } from "@pierre/diffs";
import { StrictMode, useState } from "react";

installDom();
const { fireEvent, waitFor } = await import("@testing-library/react");
if (typeof CSSStyleSheet.prototype.replaceSync !== "function") {
  Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", {
    configurable: true,
    value() {},
  });
}
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { embedCache } = await import("../src/app/embed-cache.ts");
const { WORKSPACE_CHANGED_CHANNEL } = await import("../src/shared/contract.ts");

const patch = "const example = 1;";

test("reserves room for 100 monospace columns without exceeding the message width", async () => {
  const stylesheet = await readFile(new URL("../src/app/app.css", import.meta.url), "utf8");
  expect(stylesheet).toContain("--smart-embed-target-width: calc(100ch + 8rem + 4px)");
  expect(stylesheet).toContain("box-sizing: border-box");
  expect(stylesheet).toContain("width: min(var(--smart-embed-target-width), 100%)");
  expect(stylesheet).toContain("max-width: 100%");
  expect(stylesheet).not.toContain("calc(100% + 16rem)");
  expect(stylesheet).not.toContain("transform: translateX(-50%)");
});

test("registers the smart embeds and inline visualization directives", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  expect(captured.messageDirectives.map((directive) => directive.id)).toEqual([
    "smart-diff",
    "smart-patch",
    "smart-code",
    "inline-vis",
  ]);
});

test("autorouter master visibility and per-composer pause are independent", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const action = captured.composerCustomizations.find((item) => item.id === "autorouter")!
    .actions![0]!;
  const hidden = renderSlot(
    action,
    {},
    {
      settings: { autorouterEnabled: false },
      composer: { scope: { kind: "new-thread", projectId: null } },
    },
  );
  expect(hidden.queryByRole("button")).toBeNull();
  hidden.unmount();
  const slot = renderSlot(
    action,
    {},
    {
      settings: { autorouterEnabled: true },
      composer: { scope: { kind: "new-thread", projectId: null } },
    },
  );
  fireEvent.click(slot.getByRole("button", { name: "Disable autorouter" }));
  expect(slot.getByRole("button", { name: "Enable autorouter" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(slot.rpcCalls).toHaveLength(0);
  fireEvent.click(slot.getByRole("button", { name: "Enable autorouter" }));
  expect(
    slot.getByRole("button", { name: "Disable autorouter" }).getAttribute("aria-pressed"),
  ).toBe("true");
  await slot.setComposerScope({ kind: "thread", threadId: "anthropic" });
  expect(slot.queryByRole("button")).toBeNull();
  slot.unmount();
});

test("uses the requested diff header background and unmodified theme counter colors", async () => {
  const stylesheet = await readFile(new URL("../src/app/app.css", import.meta.url), "utf8");
  const header = stylesheet.match(/\.smart-diff-header \{([^}]*)\}/u)?.[1];
  expect(header).toContain("background: #1e1e1e");
  const deletions = stylesheet.match(/\.smart-diff-deletions \{([^}]*)\}/u)?.[1];
  const additions = stylesheet.match(/\.smart-diff-additions \{([^}]*)\}/u)?.[1];
  expect(deletions).toContain("color: var(--diff-removed, var(--destructive))");
  expect(additions).toContain("color: var(--diff-added, var(--success, var(--primary)))");
  expect(deletions).not.toContain("color-mix");
  expect(additions).not.toContain("color-mix");
});

const inlineVisMessage = {
  id: "message-inline-vis",
  threadId: "thread-inline-vis",
  turnId: "turn-inline-vis",
  projectId: "project-inline-vis",
};

async function inlineVisDirective() {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = captured.messageDirectives.find((item) => item.id === "inline-vis");
  expect(directive).toBeDefined();
  return directive!;
}

test("inline-vis requires a file attribute without calling RPC", async () => {
  const directive = await inlineVisDirective();
  const slot = renderSlot(
    directive,
    {
      attributes: {},
      source: "::inline-vis{}",
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    { rpc: {} },
  );

  expect(slot.getByRole("alert").textContent).toMatch(/requires a file attribute/i);
  expect(slot.rpcCalls).toEqual([]);
  slot.unmount();
});

test("inline-vis uses the worktree route with an opaque-origin script sandbox", async () => {
  const directive = await inlineVisDirective();
  const openWorkspaceFile = mock(() => true);
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "charts/demo file.html" },
      source: '::inline-vis{file="charts/demo file.html"}',
      message: inlineVisMessage,
      openWorkspaceFile,
    },
    {
      rpc: {
        prepareHtmlPreview: (input) => {
          expect(input).toEqual({
            threadId: "thread-inline-vis",
            file: "charts/demo file.html",
          });
          return { file: "charts/demo file.html", html: "<h1>Example</h1>" };
        },
      },
    },
  );

  await slot.findByRole("status", {
    name: "Loading visualization charts/demo file.html",
  });
  const iframe = await waitFor(() => {
    const element = slot.container.querySelector("iframe");
    expect(element).toBeTruthy();
    return element as HTMLIFrameElement;
  });

  expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
  expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
  expect(iframe.getAttribute("src")).toBe(
    "/api/v1/threads/thread-inline-vis/worktree/files/charts/demo%20file.html",
  );
  expect(iframe.getAttribute("srcdoc")).toBeNull();
  expect(iframe.style.height).toBe("224px");
  const toggle = slot.getByRole("button", { name: "Collapse preview charts/demo file.html" });
  const header = toggle.closest(".smart-diff-header")!;
  expect(header.classList.contains("smart-embed-header")).toBe(true);
  expect(header.closest(".smart-embed")).toBeTruthy();
  expect(header.closest(".smart-embed-diff")).toBeTruthy();
  expect(toggle.classList.contains("smart-diff-toggle")).toBe(true);
  expect(header.querySelector(".smart-diff-file-icon")).toBeNull();
  expect(header.querySelector(".smart-diff-stats")).toBeNull();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(header.querySelector(".smart-diff-path")?.getAttribute("title")).toBe(
    "charts/demo file.html",
  );
  fireEvent.click(
    slot.getByRole("button", { name: "Open charts/demo file.html in the workspace" }),
  );
  expect(openWorkspaceFile).toHaveBeenCalledWith("charts/demo file.html");
  expect(slot.rpcCalls).toEqual([
    {
      method: "prepareHtmlPreview",
      input: { threadId: "thread-inline-vis", file: "charts/demo file.html" },
    },
  ]);
  slot.unmount();
});

test("inline-vis sends assets once only to the prepared opaque frame and stops on collapse", async () => {
  const fetchVideo = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(new Blob(["video"], { type: "video/mp4" })),
  );

  const slot = renderSlot(
    await inlineVisDirective(),
    {
      attributes: { file: "charts/player.html" },
      source: '::inline-vis{file="charts/player.html"}',
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    {
      rpc: {
        prepareHtmlPreview: () => ({
          file: "charts/player.html",
          html: '<video controls src="clip.mp4"></video>',
        }),
      },
    },
  );
  try {
    await waitFor(() =>
      expect(slot.container.querySelector("iframe")?.getAttribute("srcdoc")).toContain(
        "bb:inline-video-ready",
      ),
    );
    expect(slot.container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
    const iframe = slot.container.querySelector("iframe")!;
    const post = spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    const token = iframe.srcdoc.match(/const token = "([^"]+)"/)![1];
    const ready = (source: Window | null, value: string) =>
      window.dispatchEvent(
        new window.MessageEvent("message", {
          source,
          data: { type: "bb:inline-video-ready", token: value },
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
    fireEvent.click(slot.getByRole("button", { name: "Collapse preview charts/player.html" }));
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
  let resolvePreview = (_result: { file: string; html: string }) => {};
  const pendingPreview = new Promise<{ file: string; html: string }>((resolve) => {
    resolvePreview = resolve;
  });
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "demo.html", height: "480" },
      source: '::inline-vis{file="demo.html" height="480"}',
      message: inlineVisMessage,
      openWorkspaceFile: mock(() => true),
    },
    { rpc: { prepareHtmlPreview: () => pendingPreview } },
  );

  const loading = await slot.findByRole("status", { name: "Loading visualization demo.html" });
  expect((loading as HTMLElement).style.height).toBe("480px");
  const loadingCard = loading.parentElement!;
  const loadingHeader = loadingCard.firstElementChild!;
  expect(loadingHeader.querySelector(".smart-diff-header")).toBeNull();
  expect(loadingHeader.classList.contains("smart-diff-header")).toBe(true);
  expect(loadingHeader.querySelector(".smart-diff-open")).toBeNull();

  resolvePreview({ file: "demo.html", html: "" });
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

test("inline-vis rejects invalid heights without calling RPC", async () => {
  const directive = await inlineVisDirective();
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "demo.html", height: "100vh" },
      source: '::inline-vis{file="demo.html" height="100vh"}',
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    { rpc: {} },
  );

  expect(slot.getByRole("alert").textContent).toMatch(/whole number from 120 to 1200 pixels/i);
  expect(slot.container.querySelector("iframe")).toBeNull();
  expect(slot.rpcCalls).toEqual([]);
  slot.unmount();
});

test("inline-vis reports RPC failures without mounting an iframe", async () => {
  const directive = await inlineVisDirective();
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "missing.html" },
      source: '::inline-vis{file="missing.html"}',
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    {
      rpc: {
        prepareHtmlPreview: () => {
          throw new Error("HTML file not found: missing.html");
        },
      },
    },
  );

  const alert = await slot.findByRole("alert");
  expect(alert.textContent).toMatch(/HTML file not found: missing\.html/);
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
      attributes: { file: "same.html" },
      source: '::inline-vis{file="same.html"}',
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    { rpc: { prepareHtmlPreview: () => ({ file: "same.html", html: "" }) } },
  );
  await waitFor(() => expect(slot.container.querySelectorAll("iframe")).toHaveLength(2));
  const cards = [...slot.container.querySelectorAll(".inline-vis-card")];
  expect(cards.map((card) => !!card.querySelector("iframe"))).toEqual([false, false, true, true]);
  // StrictMode runs the two open previews' effects twice. Closed previews never prepare.
  expect(slot.rpcCalls).toHaveLength(4);
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
                attributes={{ file: `${id}.html` }}
                message={{ ...props.message, id: `message-${id}` }}
              />
            ))}
            <Component
              {...props}
              attributes={{ file: "other.html" }}
              message={{ ...props.message, threadId: "another-thread" }}
            />
          </>
        );
      },
    },
    { attributes: {}, source: "fixture", message: inlineVisMessage, openWorkspaceFile: null },
    {
      rpc: {
        prepareHtmlPreview: (input) => ({
          file: (input as { file: string }).file,
          html: "",
        }),
      },
    },
  );
  await waitFor(() => expect(slot.container.querySelectorAll("iframe")).toHaveLength(3));
  expect(slot.rpcCalls.map((call) => (call.input as { file: string }).file).sort()).toEqual([
    "2.html",
    "3.html",
    "other.html",
  ]);
  fireEvent.click(slot.getByRole("button", { name: "Expand preview 1.html" }));
  await waitFor(() => expect(slot.container.querySelectorAll("iframe")).toHaveLength(4));
  fireEvent.click(slot.getByRole("button", { name: "Collapse preview 3.html" }));
  fireEvent.click(slot.getByRole("button", { name: "Append preview" }));
  await waitFor(() => expect(slot.container.querySelectorAll("iframe")).toHaveLength(3));
  const files = () =>
    [...slot.container.querySelectorAll("iframe")].map((frame) => frame.getAttribute("title"));
  expect(files()).toEqual(["inline-vis: 1.html", "inline-vis: 4.html", "inline-vis: other.html"]);
  fireEvent.click(slot.getByRole("button", { name: "Prepend history" }));
  await waitFor(() =>
    expect(slot.getByRole("button", { name: "Expand preview 0.html" })).toBeTruthy(),
  );
  expect(files()).toEqual(["inline-vis: 1.html", "inline-vis: 4.html", "inline-vis: other.html"]);
  expect(slot.rpcCalls.some((call) => (call.input as { file: string }).file === "0.html")).toBe(
    false,
  );
  slot.unmount();
});

test("inline-vis ignores a preparation result that arrives after collapse", async () => {
  const directive = await inlineVisDirective();
  let resolvePreview = (_result: { file: string; html: string }) => {};
  const pending = new Promise<{ file: string; html: string }>((resolve) => {
    resolvePreview = resolve;
  });
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "pending.html" },
      source: "fixture",
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    { rpc: { prepareHtmlPreview: () => pending } },
  );
  await slot.findByRole("status", { name: "Loading visualization pending.html" });
  fireEvent.click(slot.getByRole("button", { name: "Collapse preview pending.html" }));
  resolvePreview({ file: "pending.html", html: "" });
  await waitFor(() =>
    expect(slot.getByRole("button", { name: "Expand preview pending.html" })).toBeTruthy(),
  );
  expect(slot.container.querySelector("iframe")).toBeNull();
  slot.unmount();
});

function readyCode(patchText: string) {
  return {
    status: "ready" as const,
    kind: "code" as const,
    path: "src/example.ts",
    label: "src/example.ts",
    content: patchText,
    startLine: 1,
    truncated: false,
  };
}

async function renderCodeEmbed(
  renderEmbed: () => Promise<import("../src/shared/contract.ts").RenderEmbedOutput>,
) {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = captured.messageDirectives.find((item) => item.id === "smart-code");
  expect(directive).toBeDefined();
  return renderSlot(
    directive!,
    {
      attributes: { path: "src/example.ts" },
      source: '::smart-code{path="src/example.ts"}',
      message: {
        id: "message-1",
        threadId: "thread-1",
        turnId: "turn-1",
        projectId: "project-1",
      },
      openWorkspaceFile: null,
    },
    { rpc: { renderEmbed } },
  );
}

test("renders citations at their source line numbers", async () => {
  embedCache.clear();
  const slot = await renderCodeEmbed(async () => ({
    status: "ready",
    kind: "code",
    path: "src/example.ts",
    label: "src/example.ts:L99-L100",
    content: "const value = 1;\nreturn value;",
    startLine: 99,
    truncated: false,
  }));
  const diff = await slot.findByTestId("bb-diff");
  expect(diff.textContent).toBe("@@ -99,2 +99,2 @@\n const value = 1;\n return value;\n");
  expect(diff.dataset.path).toBe("src/example.ts");
  expect(slot.getByText("Code")).toBeDefined();
  expect(slot.queryByText("Changes")).toBeNull();
  slot.unmount();
  embedCache.clear();
});

test("serves a remount from the cache without a loading state or a second RPC call", async () => {
  embedCache.clear();
  const first = await renderCodeEmbed(async () => readyCode(patch));
  await first.findByTestId("bb-diff");
  expect(first.rpcCalls.map((call) => call.method)).toEqual(["renderEmbed"]);
  expect(first.rpcCalls[0]?.input).toEqual({
    kind: "code",
    threadId: "thread-1",
    path: "src/example.ts",
  });
  first.unmount();

  const second = await renderCodeEmbed(async () => readyCode(patch));
  expect(second.queryByText("Loading src/example.ts…")).toBeNull();
  expect(second.getByTestId("bb-diff")).toBeDefined();
  expect(second.rpcCalls).toEqual([]);
  second.unmount();
  embedCache.clear();
});

test("refetches in place when the server reports the thread's workspace changed", async () => {
  embedCache.clear();
  let version = 0;
  const slot = await renderCodeEmbed(async () => {
    version += 1;
    return readyCode(`${patch}# v${version}\n`);
  });
  const before = await slot.findByTestId("bb-diff");
  expect(before.textContent).toContain("# v1");

  await slot.emitRealtime(WORKSPACE_CHANGED_CHANNEL, { threadId: "other", reason: "idle" });
  expect(slot.rpcCalls).toHaveLength(1);

  await slot.emitRealtime(WORKSPACE_CHANGED_CHANNEL, { threadId: "thread-1", reason: "idle" });
  await slot.findByText((_, node) => node?.textContent?.includes("# v2") === true, {
    selector: "pre",
  });
  expect(slot.rpcCalls).toHaveLength(2);
  expect(slot.queryByText("Loading src/example.ts…")).toBeNull();
  slot.unmount();
  embedCache.clear();
});

test("frees the thread's entries when it is deleted and refetches after a reconnect", async () => {
  embedCache.clear();
  const slot = await renderCodeEmbed(async () => readyCode(patch));
  await slot.findByTestId("bb-diff");
  expect(embedCache.size).toBe(1);

  await slot.emitRealtime(WORKSPACE_CHANGED_CHANNEL, { threadId: "thread-1", reason: "deleted" });
  // The entry is freed; the still-mounted embed starts over with a fresh fetch.
  await slot.findByTestId("bb-diff");
  expect(slot.rpcCalls).toHaveLength(2);

  await slot.setRealtimeConnectionState("reconnecting");
  await slot.setRealtimeConnectionState("connected");
  await slot.findByTestId("bb-diff");
  expect(slot.rpcCalls).toHaveLength(3);
  slot.unmount();
  embedCache.clear();
});

for (const { startLine, content } of [
  { startLine: 1, content: "const first = 1;" },
  { startLine: 42, content: "  const spaced = 1;  \n\t  \n" },
  { startLine: 400, content: "const first = 1;\r\nconst next = 2;\r\n  " },
]) {
  test(`renders source excerpts as unchanged context at line ${startLine}`, async () => {
    embedCache.clear();
    const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
    const directive = captured.messageDirectives.find((item) => item.id === "smart-code");
    const path = "src/space dir/example.ts";
    const openWorkspaceFile = mock(() => true);
    const slot = renderSlot(
      directive!,
      {
        attributes: { path, start: String(startLine) },
        source: "::smart-code",
        message: { id: "source-m", threadId: "source-t", turnId: "t", projectId: "p" },
        openWorkspaceFile,
      },
      {
        rpc: {
          renderEmbed: async () => ({
            status: "ready",
            kind: "code",
            path,
            label: path,
            content,
            startLine,
            truncated: true,
          }),
        },
      },
    );
    const diff = await slot.findByTestId("bb-diff");
    expect(diff.dataset.path).toBe(path);
    expect(diff.dataset.showLineNumbers).toBe("true");
    const patchText = diff.textContent!;
    expect(patchText.startsWith("@@ ")).toBe(true);
    expect(
      patchText
        .split("\n")
        .slice(1, -1)
        .map((line) => line.slice(1))
        .join("\n"),
    ).toBe(content);
    const file = parsePatchFiles(
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patchText}`,
    )[0]!.files[0]!;
    expect(file.name).toBe(path);
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]).toMatchObject({
      additionStart: startLine,
      deletionStart: startLine,
      additionCount: content.split("\n").length,
      deletionCount: content.split("\n").length,
      additionLines: 0,
      deletionLines: 0,
    });
    expect(slot.getByText("Truncated")).toBeDefined();
    slot.getByRole("button", { name: `Open ${path} in the workspace` }).click();
    expect(openWorkspaceFile).toHaveBeenCalledWith(path);
    slot.unmount();
    embedCache.clear();
  });
}

test("keeps empty non-Git source readable without an empty diff", async () => {
  embedCache.clear();
  const slot = await renderCodeEmbed(async () => ({
    status: "ready",
    kind: "code",
    path: "src/example.ts",
    label: "src/example.ts",
    content: "",
    startLine: 1,
    truncated: false,
  }));
  await slot.findByText("Empty source.");
  expect(slot.queryByTestId("bb-diff")).toBeNull();
  slot.unmount();
  embedCache.clear();
});

test("Unity citations show a single current-value column and allow raw YAML review", async () => {
  embedCache.clear();
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = captured.messageDirectives.find((item) => item.id === "smart-code")!;
  const slot = renderSlot(
    directive,
    {
      attributes: { path: "Hero.prefab" },
      source: "::smart-code",
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    {
      rpc: {
        renderEmbed: async () => ({
          status: "ready",
          kind: "code",
          path: "Hero.prefab",
          label: "Hero.prefab",
          content: "speed: 8",
          startLine: 1,
          truncated: false,
          unity: {
            propertyCount: 1,
            groups: [
              {
                id: "1",
                name: "Player",
                hierarchy: "Actors",
                components: [
                  { id: "2", type: "Movement", properties: [{ path: "speed", value: "8" }] },
                ],
              },
            ],
          },
        }),
      },
    },
  );
  await slot.findByText("Player");
  expect(slot.getByRole("columnheader", { name: "Value" })).toBeTruthy();
  expect(slot.queryByRole("columnheader", { name: "Before" })).toBeNull();
  expect(slot.queryByRole("columnheader", { name: "After" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Raw YAML" }));
  expect(slot.getByTestId("bb-diff").textContent).toContain(" speed: 8");
  fireEvent.click(slot.getByRole("button", { name: "Object view" }));
  expect(slot.getByText("Player")).toBeTruthy();
  slot.unmount();
  embedCache.clear();
});

test("smart-diff passes exact message identity and renders through BB Diff", async () => {
  embedCache.clear();
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = captured.messageDirectives.find((item) => item.id === "smart-diff")!;
  const result = {
    status: "ready",
    kind: "diff",
    path: "a.ts",
    label: "a.ts",
    patch: "@@ -1 +1 @@\n-old\n+new\n",
    source: "Recorded turn: turn-1",
    truncated: false,
  };
  const slot = renderSlot(
    directive,
    {
      attributes: { path: "a.ts" },
      source: '::smart-diff{path="a.ts"}',
      message: { id: "m", threadId: "t", turnId: "turn-1", projectId: null },
      openWorkspaceFile: null,
    },
    { rpc: { renderEmbed: async () => result } },
  );
  expect((await slot.findByTestId("bb-diff")).textContent).toBe(result.patch);
  expect(slot.rpcCalls[0]?.input).toEqual({
    kind: "diff",
    path: "a.ts",
    messageId: "m",
    threadId: "t",
    turnId: "turn-1",
  });
  expect(slot.getByText(result.source)).toBeDefined();
  slot.unmount();
  embedCache.clear();
});
test("smart-patch renders each proposal file through BB Diff", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = captured.messageDirectives.find((item) => item.id === "smart-patch")!;
  const files = [
    { path: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b\n" },
    { path: "b.ts", patch: "@@ -1 +1 @@\n-c\n+d\n" },
  ];
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "p.patch" },
      source: '::smart-patch{file="p.patch"}',
      message: { id: "m", threadId: "t", turnId: "turn-1", projectId: null },
      openWorkspaceFile: null,
    },
    {
      rpc: {
        renderEmbed: async () => ({
          status: "ready",
          kind: "patch",
          path: "p.patch",
          label: "p.patch",
          patch: "",
          files,
          source: "Proposal: p.patch",
          truncated: false,
        }),
      },
    },
  );
  await waitFor(() => expect(slot.getAllByTestId("bb-diff")).toHaveLength(2));
  expect(slot.getAllByTestId("bb-diff").map((node) => node.dataset.path)).toEqual(["a.ts", "b.ts"]);
  slot.unmount();
  embedCache.clear();
});
