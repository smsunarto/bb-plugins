// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import { promptEditorExtensions } from "./prompt-editor-extensions";
import {
  promptEditorContentFromValue,
  promptEditorValueFromDoc,
} from "./prompt-editor-serialization";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function editorWith(text: string, mention: { from: number; to: number }) {
  const editor = new Editor({
    extensions: promptEditorExtensions({ getPlaceholder: () => "" }),
    content: promptEditorContentFromValue({
      text,
      mentions: [
        {
          kind: "plugin",
          pluginId: "agentation",
          provider: "annotation",
          id: "a1",
          label: "Annotation 1",
          ...mention,
        },
      ],
    }),
  });
  editors.push(editor);
  return editor;
}

function press(editor: Editor, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, event));
}

// ProseMirror leaves plain character deletion to the browser, so these check
// that the cursor steps past the annotation and the annotation survives.
describe("hidden context mentions", () => {
  it("Backspace steps the cursor before an annotation instead of deleting it", () => {
    const editor = editorWith("fix it @a", { from: 7, to: 9 });
    const end = editor.state.doc.content.size - 1;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)));
    const mention = editor.state.selection.$from.nodeBefore!;
    press(editor, "Backspace");
    expect(editor.state.selection.from).toBe(end - mention.nodeSize);
    expect(promptEditorValueFromDoc(editor.state.doc).mentions).toHaveLength(1);
  });

  it("Delete steps the cursor after an annotation instead of deleting it", () => {
    const editor = editorWith("@a ok", { from: 0, to: 2 });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)));
    const mention = editor.state.selection.$from.nodeAfter!;
    press(editor, "Delete");
    expect(editor.state.selection.from).toBe(1 + mention.nodeSize);
    expect(promptEditorValueFromDoc(editor.state.doc).mentions).toHaveLength(1);
  });

  it("still deletes an ordinary mention with Backspace", () => {
    const editor = new Editor({
      extensions: promptEditorExtensions({ getPlaceholder: () => "" }),
      content: promptEditorContentFromValue({
        text: "see @bb",
        mentions: [{ kind: "project", projectId: "p", label: "bb", from: 4, to: 7 }],
      }),
    });
    editors.push(editor);
    const end = editor.state.doc.content.size - 1;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)));
    press(editor, "Backspace");
    expect(promptEditorValueFromDoc(editor.state.doc).mentions).toHaveLength(0);
  });
});
