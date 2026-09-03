import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDom } from "@bb-kit/core/testing";
import type { ReactElement } from "react";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { parseCanvas } from "../server/parse.ts";
import type { CanvasDocument, RenderOutput } from "../shared/document.ts";

installDom();
const { fireEvent, waitFor } = await import("@testing-library/react");
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { CanvasOpener, pollIntervalMs } = await import("./canvas.tsx");

const sample = readFileSync(
  new URL("../examples/flaky-test-triage.canvas.mdx", import.meta.url),
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
  await slot.findByText("Runs sampled");
  await slot.findByText("One root cause, three symptoms");
  assert.ok(slot.container.textContent?.includes("Flaky test triage for bb-plugins CI"));
  assert.equal(slot.container.querySelectorAll('[data-testid="bb-diff"]').length, 1);
  assert.equal(slot.queryByRole("button", { name: "Refresh" }), null);
  assert.equal(slot.queryByRole("button", { name: "Reset state" }), null);
  assert.equal(slot.queryByRole("button", { name: "Open source" }), null);
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
  await slot.findByText("Hidden body");
  fireEvent.click(slot.getByLabelText("Show details"));
  await waitFor(() => assert.equal(setCalls.length, 1));
  await waitFor(() => assert.ok(!slot.container.textContent?.includes("Hidden body")));
  slot.unmount();
});
