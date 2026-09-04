import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDom } from "@bb-kit/core/testing";
import type { ReactElement } from "react";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { parseCanvas } from "../server/parse.ts";
import type { CanvasDocument, RenderOutput } from "../shared/document.ts";

installDom();
mock.module("@pierre/diffs/react", () => ({
  FileDiff: (props: { readonly renderHeaderPrefix?: () => ReactElement }) => (
    <div data-testid="pierre-file-diff">{props.renderHeaderPrefix?.()}</div>
  ),
}));
const { fireEvent, waitFor } = await import("@testing-library/react");
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { CanvasOpener, forgetHandoffs, pollIntervalMs } = await import("./canvas.tsx");
const { CanvasPage } = await import("./page.tsx");
const { canvasPanelRoute, encodeCanvasSubPath } = await import("./route.ts");

// A canvas file tab hands off to its own pane; "Show here" renders it inline.
async function showHere(slot: ReturnType<typeof renderSlot>): Promise<void> {
  fireEvent.click(await slot.findByRole("button", { name: "Show here" }));
}

const sample = readFileSync(
  new URL("../examples/flaky-test-triage.canvas.mdx", import.meta.url),
  "utf8",
);
const githubSample = readFileSync(
  new URL("../examples/github-style.canvas.mdx", import.meta.url),
  "utf8",
);

function documentOf(source: string): CanvasDocument {
  const parsed = parseCanvas(source);
  if (!parsed.ok) throw new Error(parsed.diagnostic.message);
  return parsed.document;
}

function Original(): ReactElement {
  return <pre>ORIGINAL SOURCE</pre>;
}

function propsFor(path: string): PluginFileOpenerProps {
  return {
    path,
    source: { kind: "thread-storage", threadId: "thread-1", environmentId: null, projectId: null },
    Original,
  };
}

function rendered(source: string, sha256 = "sha-1"): RenderOutput {
  return { status: "rendered", sha256, modifiedAtMs: 1, document: documentOf(source) };
}

const emptyState = { values: {}, revision: 0 };

test("renders markdown and components from a rendered document", async () => {
  const slot = renderSlot({ component: CanvasOpener }, propsFor("canvases/triage.canvas.mdx"), {
    rpc: { render: () => rendered(sample), state: () => emptyState },
  });
  await showHere(slot);
  await slot.findByText("Runs sampled");
  await slot.findByText("One root cause, three symptoms");
  assert.ok(slot.container.textContent?.includes("Flaky test triage for bb-plugins CI"));
  assert.equal(slot.container.querySelectorAll(".canvas-diff").length, 1);
  const toggle = slot.getByRole("button", { name: "Collapse scripts/bb-dev-cli" });
  fireEvent.click(toggle);
  assert.equal(
    slot.getByRole("button", { name: "Expand scripts/bb-dev-cli" }).getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(
    slot.container.querySelector(".canvas-prose")?.getAttribute("data-canvas-style"),
    "default",
  );
  assert.equal(slot.queryByRole("button", { name: "Refresh" }), null);
  assert.equal(slot.queryByRole("button", { name: "Reset state" }), null);
  assert.equal(slot.queryByRole("button", { name: "Open source" }), null);
  slot.unmount();
});

test("applies the document style through data-canvas-style", async () => {
  const slot = renderSlot({ component: CanvasOpener }, propsFor("canvases/styled.canvas.mdx"), {
    rpc: { render: () => rendered(githubSample), state: () => emptyState },
  });
  await showHere(slot);
  await slot.findByText("Frontmatter must come first");
  assert.equal(
    slot.container.querySelector(".canvas-prose")?.getAttribute("data-canvas-style"),
    "github",
  );
  assert.equal(slot.container.querySelectorAll(".canvas-pill").length, 2);
  assert.equal(slot.container.querySelectorAll('.canvas-pill[data-tone="success"]').length, 1);
  assert.equal(slot.container.querySelectorAll('.canvas-callout[data-tone="warning"]').length, 1);
  assert.equal(slot.container.querySelectorAll(".canvas-callout-title").length, 1);
  assert.equal(slot.container.querySelectorAll(".canvas-card > .canvas-card-body").length, 1);
  assert.equal(slot.container.querySelectorAll(".canvas-card .canvas-table").length, 1);
  slot.unmount();
});

test("auto-refreshes and keeps the last good render when the file stops parsing", async () => {
  let calls = 0;
  let broken = false;
  const slot = renderSlot({ component: CanvasOpener }, propsFor("canvases/stale.canvas.mdx"), {
    rpc: {
      render: (input) => {
        calls += 1;
        const knownSha256 = (input as { knownSha256: string | null }).knownSha256;
        if (!broken) {
          return knownSha256 === "sha-good"
            ? { status: "unchanged", sha256: "sha-good" }
            : rendered('# Good\n\n<Pill label="ok" />\n', "sha-good");
        }
        if (knownSha256 !== "sha-bad") {
          return {
            status: "unparseable",
            sha256: "sha-bad",
            diagnostic: {
              code: "syntax-error",
              message: "unexpected end",
              span: { line: 3, column: 1, startOffset: 0, endOffset: 1 },
            },
          };
        }
        return { status: "unchanged", sha256: "sha-bad" };
      },
      state: () => emptyState,
    },
  });
  await showHere(slot);
  await slot.findByText("ok");
  await waitFor(() => assert.ok(calls >= 2));
  broken = true;
  await slot.findByText(
    "The file changed but no longer parses. Showing the last good render.",
    {},
    {
      timeout: pollIntervalMs * 3,
    },
  );
  assert.ok(slot.container.textContent?.includes("ok"));
  await waitFor(() => assert.ok(calls >= 4), { timeout: pollIntervalMs * 3 });
  await waitFor(() =>
    assert.ok(
      slot.container.textContent?.includes("no longer parses"),
      "banner survives unchanged",
    ),
  );
  slot.unmount();
});

test("gates non-canvas paths behind an opt-in button", async () => {
  const slot = renderSlot({ component: CanvasOpener }, propsFor("notes/plain.mdx"), {
    rpc: { render: () => rendered("# Plain\n"), state: () => emptyState },
  });
  await slot.findByText("Not a .canvas.mdx file.");
  fireEvent.click(slot.getByRole("button", { name: "Open as canvas" }));
  await waitFor(() => assert.ok(slot.container.textContent?.includes("Plain")));
  slot.unmount();
});

test("problem links switch to the source view and back", async () => {
  const slot = renderSlot({ component: CanvasOpener }, propsFor("canvases/problem.canvas.mdx"), {
    rpc: { render: () => rendered("# Title\n\n<Widget />\n"), state: () => emptyState },
  });
  await showHere(slot);
  await slot.findByText("1 problem");
  assert.equal(slot.queryByText("ORIGINAL SOURCE"), null);
  fireEvent.click(slot.getByRole("button", { name: /Widget/u }));
  await slot.findByText("ORIGINAL SOURCE");
  fireEvent.click(slot.getByRole("button", { name: "Back to canvas" }));
  await slot.findByText("1 problem");
  slot.unmount();
});

test("toggle persists through setState and hides children while off", async () => {
  const setCalls: unknown[] = [];
  const slot = renderSlot({ component: CanvasOpener }, propsFor("canvases/toggle.canvas.mdx"), {
    rpc: {
      render: () =>
        rendered(
          '<Toggle id="show" label="Show details" default={true}>\n\nHidden body\n\n</Toggle>\n',
        ),
      state: () => emptyState,
      setState: (input) => {
        setCalls.push(input);
        return { values: { show: false }, revision: 1 };
      },
    },
  });
  await showHere(slot);
  await slot.findByText("Hidden body");
  fireEvent.click(slot.getByLabelText("Show details"));
  await waitFor(() => assert.equal(setCalls.length, 1));
  await waitFor(() => assert.ok(!slot.container.textContent?.includes("Hidden body")));
  slot.unmount();
});

const threadSource = {
  kind: "thread-storage",
  threadId: "thread-1",
  path: "canvases/triage.canvas.mdx",
} as const;

test("a canvas file tab hands off to its own pane instead of rendering inline", async () => {
  forgetHandoffs();
  const modifierClicks: Event[] = [];
  const record = (event: Event): void => {
    if (event instanceof MouseEvent && event.metaKey) modifierClicks.push(event);
  };
  document.addEventListener("click", record, true);
  const slot = renderSlot({ component: CanvasOpener }, propsFor(threadSource.path), {
    rpc: { render: () => rendered(sample), state: () => emptyState },
  });
  const anchor = await slot.findByRole("link", { name: "Open pane" });
  assert.equal(anchor.getAttribute("href"), canvasPanelRoute(threadSource));
  // The host's split delegate is absent here, so the handoff falls back to
  // plain panel navigation after its synthetic modifier click goes unclaimed.
  await waitFor(() => assert.equal(modifierClicks.length, 1));
  assert.ok(modifierClicks[0]?.defaultPrevented, "the fallback cancels the anchor navigation");
  assert.deepEqual(slot.navigateCalls, [
    {
      method: "toPluginPanel",
      path: "canvas",
      options: { subPath: encodeCanvasSubPath(threadSource) },
    },
  ]);
  assert.equal(slot.queryByText("Runs sampled"), null);

  fireEvent.click(anchor);
  await waitFor(() => assert.equal(modifierClicks.length, 2));
  assert.equal(slot.navigateCalls.length, 2);

  await showHere(slot);
  await slot.findByText("Runs sampled");
  document.removeEventListener("click", record, true);
  slot.unmount();
});

test("a remounted canvas tab does not hand off again", async () => {
  forgetHandoffs();
  const modifierClicks: Event[] = [];
  const record = (event: Event): void => {
    if (event instanceof MouseEvent && event.metaKey) modifierClicks.push(event);
  };
  document.addEventListener("click", record, true);
  const rpcs = { render: () => rendered(sample), state: () => emptyState };
  const first = renderSlot({ component: CanvasOpener }, propsFor(threadSource.path), { rpc: rpcs });
  await first.findByRole("link", { name: "Open pane" });
  await waitFor(() => assert.equal(modifierClicks.length, 1));
  // bb restores thread tabs on every visit and remounts the side panel when
  // the thread pane regains focus, including right after the canvas pane closes.
  first.unmount();
  const second = renderSlot({ component: CanvasOpener }, propsFor(threadSource.path), {
    rpc: rpcs,
  });
  const anchor = await second.findByRole("link", { name: "Open pane" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(modifierClicks.length, 1, "the restored tab stays quiet");
  assert.deepEqual(second.navigateCalls, []);
  // The button still opens the pane on demand.
  fireEvent.click(anchor);
  await waitFor(() => assert.equal(modifierClicks.length, 2));
  assert.equal(second.navigateCalls.length, 1);
  document.removeEventListener("click", record, true);
  second.unmount();
});

test("the page renders the canvas named by its sub-path", async () => {
  const slot = renderSlot(
    { component: CanvasPage },
    { subPath: encodeCanvasSubPath(threadSource) },
    { rpc: { render: () => rendered(sample), state: () => emptyState } },
  );
  await slot.findByText("Runs sampled");
  assert.equal(slot.queryByText("Show here"), null);
  slot.unmount();
});

test("the page source view reads the raw text through the source rpc", async () => {
  const slot = renderSlot(
    { component: CanvasPage },
    { subPath: encodeCanvasSubPath(threadSource) },
    {
      rpc: {
        render: () => rendered("# Title\n\n<Widget />\n"),
        state: () => emptyState,
        source: () => ({ status: "ok", sha256: "s", content: "# Title\n\n<Widget />\n" }),
      },
    },
  );
  await slot.findByText("1 problem");
  fireEvent.click(slot.getByRole("button", { name: /Widget/u }));
  await waitFor(() =>
    assert.equal(slot.container.querySelectorAll('[data-testid="bb-source-code"]').length, 1),
  );
  fireEvent.click(slot.getByRole("button", { name: "Back to canvas" }));
  await slot.findByText("1 problem");
  slot.unmount();
});

test("the page explains itself when the sub-path names no canvas", async () => {
  const slot = renderSlot({ component: CanvasPage }, { subPath: "" }, { rpc: {} });
  await slot.findByText(/Open a canvas link from a chat/u);
  slot.unmount();
});
