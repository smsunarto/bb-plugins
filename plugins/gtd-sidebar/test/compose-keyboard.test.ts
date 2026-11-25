import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, it, mock } from "bun:test";
import { installDom } from "@bb-plugins/testing";
import { focusComposeEditorWithKeyboard } from "../lib/compose-keyboard";

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
  drawer.remove();
  document.querySelector("[data-gtd-keyboard-proxy]")?.remove();
  Reflect.deleteProperty(document, "execCommand");
});

it("transfers early typing once after the drawer closes and the composer takes focus", async () => {
  focusComposeEditorWithKeyboard(document);
  const proxy = document.querySelector<HTMLInputElement>("[data-gtd-keyboard-proxy]")!;
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
