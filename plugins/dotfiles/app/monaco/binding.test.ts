import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import { installDom } from "@bb-kit/core/testing";
import type { PluginCodeThemeData, PluginCodeThemeState } from "@get-bb/plugin-sdk/app";
import type * as MonacoNs from "monaco-editor";
import { createMonacoBinding } from "./binding.ts";

installDom();

const lightTheme: PluginCodeThemeState = {
  mode: "light",
  name: "light",
  theme: null,
};

const darkDocument: PluginCodeThemeData = {
  name: "dotfiles-dark",
  type: "dark",
  fg: "#eeeeee",
  bg: "#111111",
  colors: {},
  tokenColors: [],
};

function fakeMonaco() {
  let value = "initial";
  let changeListener: (() => void) | null = null;
  let blurListener: (() => void) | null = null;
  let saveCommand: (() => void) | null = null;
  const modelDispose = mock<() => void>();
  const editorDispose = mock<() => void>();
  const changeDispose = mock<() => void>();
  const blurDispose = mock<() => void>();
  const setValue = mock<(next: string) => void>((next) => {
    value = next;
    changeListener?.();
  });
  const updateOptions = mock<(options: { theme?: string }) => void>();
  const defineTheme = mock<(name: string, data: MonacoNs.editor.IStandaloneThemeData) => void>();
  const createModel = mock((initialValue: string) => {
    value = initialValue;
    return {
      getValue: () => value,
      setValue,
      dispose: modelDispose,
    };
  });
  const create = mock((_container: HTMLElement, _options: unknown) => ({
    onDidChangeModelContent(listener: () => void) {
      changeListener = listener;
      return { dispose: changeDispose };
    },
    onDidBlurEditorWidget(listener: () => void) {
      blurListener = listener;
      return { dispose: blurDispose };
    },
    addCommand(_keybinding: number, command: () => void) {
      saveCommand = command;
      return "save";
    },
    updateOptions,
    dispose: editorDispose,
  }));
  const monaco = {
    editor: { createModel, create, defineTheme },
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyS: 2 },
  } as unknown as typeof MonacoNs;

  return {
    monaco,
    create,
    createModel,
    defineTheme,
    updateOptions,
    setValue,
    modelDispose,
    editorDispose,
    changeDispose,
    blurDispose,
    userEdit(next: string) {
      value = next;
      changeListener?.();
    },
    blur() {
      blurListener?.();
    },
    save() {
      saveCommand?.();
    },
  };
}

test("emits user edits and suppresses changes during external value sync", () => {
  const fake = fakeMonaco();
  const onChange = mock<(next: string) => void>();
  const binding = createMonacoBinding(fake.monaco, document.createElement("div"), "mise.toml", {
    value: "initial",
    codeTheme: lightTheme,
    onChange,
    onSave: () => {},
  });

  fake.userEdit("user edit");
  binding.update({ value: "external", codeTheme: lightTheme, onChange, onSave: () => {} });

  assert.deepEqual(onChange.mock.calls, [["user edit"]]);
  assert.deepEqual(fake.setValue.mock.calls, [["external"]]);
  assert.equal(fake.createModel.mock.calls.length, 1);
  assert.equal(fake.create.mock.calls.length, 1);
  binding.dispose();
});

test("uses the latest callbacks for edits, blur, and CtrlCmd+S", () => {
  const fake = fakeMonaco();
  const firstChange = mock<(next: string) => void>();
  const latestChange = mock<(next: string) => void>();
  const firstSave = mock<() => void>();
  const latestSave = mock<() => void>();
  const binding = createMonacoBinding(fake.monaco, document.createElement("div"), "file.ts", {
    value: "initial",
    codeTheme: lightTheme,
    onChange: firstChange,
    onSave: firstSave,
  });

  binding.update({
    value: "initial",
    codeTheme: lightTheme,
    onChange: latestChange,
    onSave: latestSave,
  });
  fake.userEdit("latest edit");
  fake.blur();
  fake.save();

  assert.equal(firstChange.mock.calls.length, 0);
  assert.deepEqual(latestChange.mock.calls, [["latest edit"]]);
  assert.equal(firstSave.mock.calls.length, 0);
  assert.equal(latestSave.mock.calls.length, 2);
  binding.dispose();
});

test("updates Monaco and overflow widgets when the BB theme changes", () => {
  const fake = fakeMonaco();
  const binding = createMonacoBinding(fake.monaco, document.createElement("div"), "file.ts", {
    value: "initial",
    codeTheme: lightTheme,
    onChange: () => {},
    onSave: () => {},
  });

  binding.update({
    value: "initial",
    codeTheme: { mode: "dark", name: darkDocument.name, theme: darkDocument },
    onChange: () => {},
    onSave: () => {},
  });

  assert.equal(fake.defineTheme.mock.calls[0]?.[0], "bb-dotfiles-dark");
  assert.deepEqual(fake.updateOptions.mock.calls, [[{ theme: "bb-dotfiles-dark" }]]);
  assert.equal(document.body.lastElementChild?.className, "monaco-editor vs-dark");
  binding.dispose();
});

test("disposes each owned resource exactly once", () => {
  const fake = fakeMonaco();
  const binding = createMonacoBinding(fake.monaco, document.createElement("div"), "file.ts", {
    value: "initial",
    codeTheme: lightTheme,
    onChange: () => {},
    onSave: () => {},
  });
  const overflowNode = document.body.lastElementChild as HTMLElement;
  const remove = mock<() => void>();
  overflowNode.remove = remove;

  binding.dispose();
  binding.dispose();

  assert.equal(fake.changeDispose.mock.calls.length, 1);
  assert.equal(fake.blurDispose.mock.calls.length, 1);
  assert.equal(fake.editorDispose.mock.calls.length, 1);
  assert.equal(fake.modelDispose.mock.calls.length, 1);
  assert.equal(remove.mock.calls.length, 1);
  overflowNode.parentNode?.removeChild(overflowNode);
});
