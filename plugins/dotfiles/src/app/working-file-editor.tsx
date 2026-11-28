import { useEffect, useLayoutEffect, useRef, type ReactElement } from "react";
import { minimalSetup } from "codemirror";
import { Annotation, EditorState, StateEffect } from "@codemirror/state";
import {
  EditorView,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  HighlightStyle,
  LanguageDescription,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "./editor-languages.ts";
import type { RepoPath } from "./route.ts";

export interface WorkingFileEditorProps {
  readonly path: RepoPath;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onSave: () => void;
}

const externalChange = Annotation.define<boolean>();
/**
 * What a dotfile editor needs, without `basicSetup`'s autocompletion, lint,
 * folding, and search panels. `minimalSetup` brings undo history, the default
 * and history keymaps, drawn selections, and special-character highlighting.
 */
const editingSetup = [
  minimalSetup,
  lineNumbers(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  dropCursor(),
  indentOnInput(),
  bracketMatching(),
];
const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--background)", color: "var(--foreground)" },
  ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)", fontSize: "12px" },
  // iOS zooms the page into a focused field under 16px and stays zoomed.
  "@media (max-width: 767px) and (pointer: coarse)": { ".cm-scroller": { fontSize: "16px" } },
  ".cm-gutters": {
    backgroundColor: "var(--background)",
    color: "var(--muted-foreground)",
    borderColor: "var(--border)",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--muted)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--accent)",
  },
});

/**
 * Source editing for every file, Markdown included: Markdown gets CodeMirror's
 * Markdown language rather than a rich-text editor, which kept ~600 KB of
 * TipTap in the startup bundle.
 */
export function WorkingFileEditor({
  path,
  value,
  onChange,
  onSave,
}: WorkingFileEditorProps): ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ value, onChange, onSave });
  useLayoutEffect(() => {
    callbacks.current = { value, onChange, onSave };
  }, [value, onChange, onSave]);

  useEffect(() => {
    if (!container.current) return;
    const editor = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: callbacks.current.value,
        extensions: [
          editingSetup,
          EditorState.lineSeparator.of(callbacks.current.value.includes("\r\n") ? "\r\n" : "\n"),
          editorTheme,
          syntaxHighlighting(
            HighlightStyle.define([
              { tag: tags.keyword, color: "var(--ansi-13, var(--foreground))" },
              {
                tag: [tags.string, tags.number, tags.bool],
                color: "var(--ansi-11, var(--foreground))",
              },
              { tag: [tags.propertyName, tags.variableName], color: "var(--foreground)" },
              { tag: tags.comment, color: "var(--muted-foreground)" },
            ]),
          ),
          EditorView.contentAttributes.of({ "aria-label": `Edit ${path}` }),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
          ]),
          EditorView.domEventHandlers({
            blur: () => {
              callbacks.current.onSave();
            },
          }),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((tr) => tr.annotation(externalChange))
            ) {
              callbacks.current.onChange(update.state.sliceDoc());
            }
          }),
        ],
      }),
    });
    view.current = editor;
    let disposed = false;
    const language = LanguageDescription.matchFilename(languages, path);
    if (language)
      void language.load().then((support) => {
        if (!disposed) editor.dispatch({ effects: StateEffect.appendConfig.of(support) });
        return undefined;
      });
    return () => {
      disposed = true;
      view.current = null;
      editor.destroy();
    };
  }, [path]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.sliceDoc() !== value) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        annotations: externalChange.of(true),
      });
    }
  }, [value]);
  return <div ref={container} className="min-h-0 flex-1 overflow-hidden" />;
}
