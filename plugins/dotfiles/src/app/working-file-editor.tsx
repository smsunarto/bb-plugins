import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { basicSetup } from "codemirror";
import { Annotation, EditorState, StateEffect } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { HighlightStyle, syntaxHighlighting, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { MarkdownEditor } from "@smsunarto/bb-plugin-canvas/editor";
import type { RepoPath } from "./route.ts";

export interface WorkingFileEditorProps {
  readonly path: RepoPath;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onSave: () => void;
}

const externalChange = Annotation.define<boolean>();
const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--background)", color: "var(--foreground)" },
  ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)", fontSize: "12px" },
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

function SourceEditor({ path, value, onChange, onSave }: WorkingFileEditorProps): ReactElement {
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
          basicSetup,
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

function RichEditor(props: WorkingFileEditorProps): ReactElement {
  const [initialValue, setInitialValue] = useState(props.value);
  const lastValue = useRef(props.value);
  useEffect(() => {
    if (props.value !== lastValue.current) {
      lastValue.current = props.value;
      setInitialValue(props.value);
    }
  }, [props.value]);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) props.onSave();
      }}
    >
      <MarkdownEditor
        initialValue={initialValue}
        notePath={props.path}
        previewBaseUrl=""
        onFirstRender={() => {}}
        onMarkdownChange={(next) => {
          lastValue.current = next;
          props.onChange(next);
        }}
        onProposalApplied={(result) => {
          lastValue.current = result.content;
          props.onChange(result.content);
        }}
      />
    </div>
  );
}

export function WorkingFileEditor(props: WorkingFileEditorProps): ReactElement {
  return /\.(md|mdx|markdown)$/i.test(props.path) ? (
    <RichEditor key={props.path} {...props} />
  ) : (
    <SourceEditor {...props} />
  );
}
