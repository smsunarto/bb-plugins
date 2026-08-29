import { mock, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { installDom } from "@bb-kit/core/testing";
import type * as MonacoNs from "monaco-editor";
import type { MonacoAcquisition } from "./monaco/runtime.ts";

installDom();
const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { monacoRuntime } = await import("./monaco/runtime.ts");
const { WorkingFileEditor } = await import("./working-file-editor.tsx");

const props = {
  path: "mise.toml" as const,
  value: "initial",
  onChange: mock<(next: string) => void>(),
  onSave: mock<() => void>(),
};

test("releases a late acquisition without creating an editor after unmount", async () => {
  let resolveAcquisition!: (acquisition: MonacoAcquisition) => void;
  const release = mock<() => void>();
  const acquire = spyOn(monacoRuntime, "acquire").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveAcquisition = resolve;
      }),
  );

  try {
    const slot = renderSlot({ component: WorkingFileEditor }, props);
    await slot.findByText("Loading editor…");
    slot.unmount();
    await act(async () => {
      resolveAcquisition({ monaco: {} as typeof MonacoNs, release });
      await Promise.resolve();
    });

    assert.equal(acquire.mock.calls.length, 1);
    assert.equal(release.mock.calls.length, 1);
  } finally {
    acquire.mockRestore();
  }
});

test("shows an actionable error and retries a failed boot", async () => {
  let attempt = 0;
  const acquire = spyOn(monacoRuntime, "acquire").mockImplementation(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("module unavailable");
    return new Promise<MonacoAcquisition>(() => {});
  });

  try {
    const slot = renderSlot({ component: WorkingFileEditor }, props);
    await slot.findByText("Could not load the editor. module unavailable");
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await waitFor(() => assert.equal(acquire.mock.calls.length, 2));
    slot.unmount();
  } finally {
    acquire.mockRestore();
  }
});

test("disposes the binding before releasing the acquisition", async () => {
  const order: string[] = [];
  const model = {
    getValue: () => "initial",
    setValue() {},
    dispose: mock(() => order.push("model")),
  };
  const editor = {
    onDidChangeModelContent: () => ({ dispose: mock(() => order.push("change subscription")) }),
    onDidBlurEditorWidget: () => ({ dispose: mock(() => order.push("blur subscription")) }),
    addCommand: () => "save",
    updateOptions() {},
    dispose: mock(() => order.push("editor")),
  };
  const createEditor = mock(() => editor);
  const monaco = {
    editor: {
      createModel: mock(() => model),
      create: createEditor,
      defineTheme() {},
    },
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyS: 2 },
  } as unknown as typeof MonacoNs;
  const release = mock(() => order.push("release"));
  const acquire = spyOn(monacoRuntime, "acquire").mockResolvedValue({ monaco, release });

  try {
    const slot = renderSlot({ component: WorkingFileEditor }, props);
    await waitFor(() => assert.equal(createEditor.mock.calls.length, 1));
    slot.unmount();

    assert.deepEqual(order, [
      "change subscription",
      "blur subscription",
      "editor",
      "model",
      "release",
    ]);
  } finally {
    acquire.mockRestore();
  }
});
