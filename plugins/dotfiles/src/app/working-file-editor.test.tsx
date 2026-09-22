import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import { installDom } from "@bb-kit/core/testing";
import { EditorView } from "@codemirror/view";

installDom();
// jsdom has no layout engine. CodeMirror asks ranges for geometry.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const { act, fireEvent } = await import("@testing-library/react");
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { WorkingFileEditor } = await import("./working-file-editor.tsx");

test("source edits emit the current document and save on blur", async () => {
  const onChange = mock<(value: string) => void>();
  const onSave = mock<() => void>();
  const slot = renderSlot(
    { component: WorkingFileEditor },
    {
      path: "unknown.txt",
      value: "original\n",
      onChange,
      onSave,
    },
  );
  const textbox = await slot.findByRole("textbox", { name: "Edit unknown.txt" });
  assert.equal(textbox.textContent, "original");
  assert.equal(onChange.mock.calls.length, 0);
  const editor = EditorView.findFromDOM(textbox);
  assert.ok(editor);
  await act(async () => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "changed\n" } });
  });
  assert.deepEqual(onChange.mock.calls, [["changed\n"]]);
  fireEvent.blur(textbox);
  assert.equal(onSave.mock.calls.length, 1);
  slot.unmount();
});
