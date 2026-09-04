import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import { installDom } from "@bb-kit/core/testing";
import type { ReactElement } from "react";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { parseCanvas } from "../server/parse.ts";
import type { CanvasDocument, RenderOutput } from "../shared/document.ts";

installDom();
mock.module("@pierre/diffs/react", () => ({
  FileDiff: () => <div data-testid="pierre-file-diff" />,
}));
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { CanvasOpener } = await import("./canvas.tsx");

const source = `# Tones

<Pill label="ok" tone="success" />

<Callout tone="warning" title="Heads up">

body

</Callout>

<Stat label="p95" value="120ms" delta="+3%" tone="danger" />

<Table headers={["a"]} rows={[["x"]]} rowTone={["info"]} />

<Row gap="sm">
  <Pill label="style: github" tone="info" />
  <Pill label="frontmatter parsed" tone="success" />
</Row>
`;

function documentOf(text: string): CanvasDocument {
  const parsed = parseCanvas(text);
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

function rendered(text: string): RenderOutput {
  return { status: "rendered", sha256: "sha-1", modifiedAtMs: 1, document: documentOf(text) };
}

test("toned components expose data-tone and carry no Tailwind palette classes", async () => {
  const slot = renderSlot({ component: CanvasOpener }, propsFor("canvases/tones.canvas.mdx"), {
    rpc: { render: () => rendered(source), state: () => ({ values: {}, revision: 0 }) },
  });
  await slot.findByText("Heads up");
  const root = slot.container.querySelector(".canvas-prose");
  assert.ok(root);
  assert.ok(root.querySelector('.canvas-pill[data-tone="success"]'));
  assert.ok(root.querySelector('.canvas-callout[data-tone="warning"] .canvas-callout-title'));
  assert.ok(root.querySelector('.canvas-stat[data-tone="danger"] .canvas-stat-delta'));
  assert.ok(root.querySelector('.canvas-table tr[data-tone="info"]'));
  assert.doesNotMatch(root.innerHTML, /(sky|emerald|amber|red)-[0-9]/);
  slot.unmount();
});

test("pills inside a Row keep the canvas-row hook that stops them stretching", async () => {
  const slot = renderSlot({ component: CanvasOpener }, propsFor("canvases/tones.canvas.mdx"), {
    rpc: { render: () => rendered(source), state: () => ({ values: {}, revision: 0 }) },
  });
  await slot.findByText("style: github");
  const pills = [...slot.container.querySelectorAll(".canvas-row .canvas-pill")];
  assert.equal(pills.length, 2);
  for (const pill of pills) {
    const wrapper = pill.parentElement;
    assert.ok(wrapper);
    assert.ok(wrapper.parentElement?.classList.contains("canvas-row"));
  }
  slot.unmount();
});
