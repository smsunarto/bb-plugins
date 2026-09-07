import type { PluginCodeThemeState } from "@get-bb/plugin-sdk/app";
import type * as MonacoNs from "monaco-editor";
import { languageForPath } from "./language.ts";
import { applyCodeTheme } from "./theme.ts";

export interface MonacoBindingInput {
  readonly value: string;
  readonly codeTheme: PluginCodeThemeState;
  readonly onChange: (next: string) => void;
  readonly onSave: () => void;
}

export interface MonacoBinding {
  update(input: MonacoBindingInput): void;
  dispose(): void;
}

export function createMonacoBinding(
  monaco: typeof MonacoNs,
  container: HTMLElement,
  path: string,
  input: MonacoBindingInput,
): MonacoBinding {
  let callbacks = { onChange: input.onChange, onSave: input.onSave };
  let syncingExternalValue = false;
  let disposed = false;
  let themeMode = input.codeTheme.mode;
  let themeName = input.codeTheme.name;
  let themeDocument = input.codeTheme.theme;

  const appliedTheme = applyCodeTheme(monaco, input.codeTheme);
  const overflowNode = document.createElement("div");
  overflowNode.className = `monaco-editor ${appliedTheme.base}`;
  overflowNode.style.position = "absolute";
  overflowNode.style.top = "0";
  overflowNode.style.left = "0";
  overflowNode.style.zIndex = "40";
  document.body.appendChild(overflowNode);

  const model = monaco.editor.createModel(input.value, languageForPath(path));
  const fontFamily = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  const editor = monaco.editor.create(container, {
    model,
    automaticLayout: true,
    lineNumbers: "on",
    theme: appliedTheme.name,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 12,
    lineHeight: 20,
    ...(fontFamily === "" ? {} : { fontFamily }),
    ariaLabel: `Edit ${path}`,
    fixedOverflowWidgets: true,
    overflowWidgetsDomNode: overflowNode,
  });

  const changeSubscription = editor.onDidChangeModelContent(() => {
    if (!syncingExternalValue) callbacks.onChange(model.getValue());
  });
  const blurSubscription = editor.onDidBlurEditorWidget(() => callbacks.onSave());
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.onSave());

  return {
    update(next) {
      if (disposed) return;
      callbacks = { onChange: next.onChange, onSave: next.onSave };
      if (model.getValue() !== next.value) {
        syncingExternalValue = true;
        try {
          model.setValue(next.value);
        } finally {
          syncingExternalValue = false;
        }
      }
      if (
        themeMode !== next.codeTheme.mode ||
        themeName !== next.codeTheme.name ||
        themeDocument !== next.codeTheme.theme
      ) {
        themeMode = next.codeTheme.mode;
        themeName = next.codeTheme.name;
        themeDocument = next.codeTheme.theme;
        const applied = applyCodeTheme(monaco, next.codeTheme);
        overflowNode.className = `monaco-editor ${applied.base}`;
        editor.updateOptions({ theme: applied.name });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      changeSubscription.dispose();
      blurSubscription.dispose();
      editor.dispose();
      model.dispose();
      overflowNode.remove();
    },
  };
}
