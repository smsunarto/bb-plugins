import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, it, mock } from "bun:test";
import { waitFor } from "@testing-library/react";
import { installDom } from "@bb-plugins/testing";
import {
  cancelComposeKeyboardHandoff,
  focusComposeEditorWithKeyboard,
} from "../lib/compose-keyboard";

installDom();

let drawer: HTMLElement;
let editor: HTMLElement;
let insertText: ReturnType<typeof mock>;

beforeEach(() => {
  drawer = document.createElement("main");
  drawer.setAttribute("data-sidebar", "inset");
  drawer.setAttribute("data-sidebar-shelf", "open");
  drawer.innerHTML = `
    <div id="root-compose-main-panel">
      <div data-promptbox><div contenteditable="true" tabindex="0"></div></div>
    </div>`;
  document.body.append(drawer);
  editor = drawer.querySelector<HTMLElement>('[contenteditable="true"]')!;
  insertText = mock(() => assert.equal(document.activeElement, editor));
  Object.defineProperty(document, "execCommand", { configurable: true, value: insertText });
});

afterEach(() => {
  cancelComposeKeyboardHandoff(document);
  drawer.remove();
  Reflect.deleteProperty(document, "execCommand");
});

it("transfers early typing once after the drawer closes and the composer takes focus", async () => {
  focusComposeEditorWithKeyboard(document);
  const proxy = document.querySelector<HTMLTextAreaElement>("[data-gtd-keyboard-proxy]")!;
  assert.equal(document.activeElement, proxy);
  proxy.value = "Draft";

  await sleep(150);
  assert.equal(document.activeElement, proxy);
  assert.equal(insertText.mock.calls.length, 0);

  drawer.setAttribute("data-sidebar-shelf", "closed");
  await sleep(100);
  assert.equal(document.activeElement, editor);
  assert.equal(proxy.isConnected, false);
  assert.deepEqual(insertText.mock.calls, [["insertText", false, "Draft"]]);
});

it("cancels the handoff if the user focuses another field", async () => {
  const other = document.createElement("input");
  drawer.append(other);
  focusComposeEditorWithKeyboard(document);
  other.focus();

  drawer.setAttribute("data-sidebar-shelf", "closed");
  assert.equal(document.querySelector("[data-gtd-keyboard-proxy]"), null);
  await sleep(150);
  assert.equal(document.activeElement, other);
  assert.equal(insertText.mock.calls.length, 0);
});

it("waits for the editor's focus to complete after an early blur", async () => {
  const view = document.defaultView!;
  editor.textContent = "Existing ";
  focusComposeEditorWithKeyboard(document);
  const proxy = document.querySelector<HTMLTextAreaElement>("[data-gtd-keyboard-proxy]")!;
  proxy.value = "Draft";

  // Trusted input can yield to the microtask queue between blur and focusin.
  proxy.dispatchEvent(new view.FocusEvent("blur", { relatedTarget: editor }));
  await sleep(0);
  assert.equal(insertText.mock.calls.length, 0);
  assert.equal(proxy.isConnected, true);

  document.getSelection()?.collapse(editor, 0);
  editor.focus();
  await waitFor(() => assert.equal(proxy.isConnected, false));
  assert.equal(document.activeElement, editor);
  assert.equal(document.getSelection()?.anchorNode, editor);
  assert.equal(document.getSelection()?.anchorOffset, editor.childNodes.length);
  assert.equal(proxy.isConnected, false);
  assert.deepEqual(insertText.mock.calls, [["insertText", false, "Draft"]]);
});

for (const [description, selectionEnd] of [
  ["partial", 3],
  ["whole-draft", 8],
] as const) {
  it(`appends multiple lines with a stored ${description} selection`, async () => {
    const view = document.defaultView!;
    const draft = "Existing";
    editor.textContent = draft;
    editor.focus();
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(editor.firstChild!, 0, editor.firstChild!, selectionEnd);

    // A rich-text paste consumer can still act on its previously stored range.
    const paste = mock((event: Event) => {
      event.preventDefault();
      editor.textContent = "First\nSecond" + draft.slice(selectionEnd);
    });
    editor.addEventListener("paste", paste);
    Object.defineProperty(view, "DataTransfer", {
      configurable: true,
      value: class {
        setData() {}
      },
    });
    Object.defineProperty(view, "ClipboardEvent", {
      configurable: true,
      value: view.Event,
    });

    try {
      const nativeInsert = mock((_command: string, _ui: boolean, text: string) => {
        const range = selection.getRangeAt(0);
        assert.equal(range.collapsed, true);
        assert.equal(range.endContainer, editor);
        assert.equal(range.endOffset, editor.childNodes.length);
        range.insertNode(document.createTextNode(text));
      });
      Object.defineProperty(document, "execCommand", { configurable: true, value: nativeInsert });

      focusComposeEditorWithKeyboard(document);
      const proxy = document.querySelector<HTMLTextAreaElement>("[data-gtd-keyboard-proxy]")!;
      proxy.value = "First <draft>&\nSecond";
      editor.focus();
      await waitFor(() => assert.equal(proxy.isConnected, false));

      assert.equal(editor.textContent, "ExistingFirst <draft>&\nSecond");
      assert.deepEqual(nativeInsert.mock.calls, [["insertText", false, "First <draft>&\nSecond"]]);
      assert.equal(paste.mock.calls.length, 0);
    } finally {
      Reflect.deleteProperty(view, "DataTransfer");
      Reflect.deleteProperty(view, "ClipboardEvent");
    }
  });
}

it("wakes on editor mount without probing a closed, idle drawer", async () => {
  const prompt = editor.parentElement!;
  editor.remove();
  drawer.setAttribute("data-sidebar-shelf", "closed");
  const query = mock(drawer.querySelector.bind(drawer));
  drawer.querySelector = query;

  focusComposeEditorWithKeyboard(document);
  const proxy = document.querySelector<HTMLTextAreaElement>("[data-gtd-keyboard-proxy]")!;
  proxy.value = "Delayed draft";
  await sleep(350);
  assert.equal(document.activeElement, proxy);
  assert.equal(query.mock.calls.length, 1);

  prompt.append(editor);
  await waitFor(() => assert.equal(proxy.isConnected, false));
  assert.deepEqual(insertText.mock.calls, [["insertText", false, "Delayed draft"]]);
});

it("cleans up on expiry and leaves a later editor mount alone", async () => {
  const prompt = editor.parentElement!;
  editor.remove();
  drawer.setAttribute("data-sidebar-shelf", "closed");
  focusComposeEditorWithKeyboard(document);
  await sleep(3100);
  assert.equal(document.querySelector("[data-gtd-keyboard-proxy]"), null);

  prompt.append(editor);
  await sleep(0);
  assert.notEqual(document.activeElement, editor);
  assert.equal(insertText.mock.calls.length, 0);
});

it("cancels the pending handoff when the plugin unmounts", async () => {
  focusComposeEditorWithKeyboard(document);
  cancelComposeKeyboardHandoff(document);
  drawer.setAttribute("data-sidebar-shelf", "closed");
  await sleep(150);
  assert.equal(document.querySelector("[data-gtd-keyboard-proxy]"), null);
  assert.notEqual(document.activeElement, editor);
});
