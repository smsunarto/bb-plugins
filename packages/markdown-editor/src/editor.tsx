import {
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import type { Editor, Extensions, EditorOptions } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import {
  createMarkdownEditor,
  markdownExtensions,
  sourceModeReason,
  type MarkdownSession,
  splitEditableDocument,
} from "./engine";
import "./editor.css";

export interface MarkdownEditorHandle {
  focus(): void;
}
export interface MarkdownEditorProps {
  value: string;
  onChange(value: string): void;
  "aria-label": string;
  "aria-describedby"?: string;
  "aria-keyshortcuts"?: string;
  id?: string;
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  maxLength?: number;
  onBlur?(value: string): void;
  onSave?(): void;
  onKeyDown?(event: KeyboardEvent<HTMLElement>): void;
  ref?: Ref<MarkdownEditorHandle>;
  extensions?: Extensions;
  editorProps?: EditorOptions["editorProps"];
  onEditor?(editor: Editor | null): void;
  transformIn?(source: string): string;
  transformOut?(source: string): string;
  renderSource?(props: { value: string; onChange(value: string): void; onSave(): void }): ReactNode;
}

const HIDDEN_CONTENT = "Source mode preserves content the rich editor cannot display.";

export function MarkdownEditor(props: MarkdownEditorProps) {
  const [mode, setMode] = useState<"rich" | "source">("rich");
  const [limit, setLimit] = useState(false);
  const focused = useRef(false);
  const focusOnMount = useRef(props.autoFocus ?? false);
  const root = useRef<HTMLFieldSetElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const sessionRef = useRef<MarkdownSession | null>(null);
  const latest = useRef(props);
  const current = useRef(props.value);
  const emitted = useRef<string | null>(null);
  const document = splitEditableDocument(props.value);
  const header = document.prefix + document.yaml + document.suffix;
  const [blocked, setBlocked] = useState<{ body: string; reason: string } | null>(() => {
    const reason = sourceModeReason(document.body);
    return reason ? { body: document.body, reason } : null;
  });
  const reason = blocked?.body === document.body ? blocked.reason : null;
  const rich = mode === "rich" && !reason;
  /** Record why rich mode cannot show `body`: its syntax first, then content the parse dropped. */
  const inspect = (body: string, hidden: boolean) => {
    const reason = sourceModeReason(body) ?? (hidden ? HIDDEN_CONTENT : null);
    setBlocked(reason ? { body, reason } : null);
  };
  useLayoutEffect(() => {
    latest.current = props;
    current.current = props.value;
  });
  const change = (value: string) => {
    if (latest.current.readOnly) return;
    const max = latest.current.maxLength;
    if (max !== undefined && value.length > max && value.length > current.current.length) {
      setLimit(true);
      return;
    }
    setLimit(false);
    current.current = value;
    emitted.current = value;
    latest.current.onChange(value);
  };
  const changeBody = (body: string) => {
    const parts = splitEditableDocument(current.current);
    change(parts.prefix + parts.yaml + parts.suffix + body);
  };
  const focus = () => {
    if (editorRef.current) editorRef.current.commands.focus();
    else root.current?.querySelector<HTMLElement>("textarea[data-markdown-source]")?.focus();
  };
  useImperativeHandle(props.ref, () => ({ focus }));
  useLayoutEffect(() => {
    if (!rich || !surface.current) return;
    const maxLength = Extension.create({
      name: "markdownLength",
      addProseMirrorPlugins: () => [
        new Plugin({
          filterTransaction(transaction, state) {
            if (!transaction.docChanged || !sessionRef.current) return true;
            const max = latest.current.maxLength;
            if (max === undefined) return true;
            const parts = splitEditableDocument(current.current);
            const headerSize = parts.prefix.length + parts.yaml.length + parts.suffix.length;
            const size = headerSize + sessionRef.current.getMarkdown(transaction.doc).length;
            if (
              size <= max ||
              size <= headerSize + sessionRef.current.getMarkdown(state.doc).length
            )
              return true;
            setLimit(true);
            return false;
          },
        }),
      ],
    });
    const { editor, session } = createMarkdownEditor({
      value: splitEditableDocument(current.current).body,
      element: surface.current,
      editable: !latest.current.readOnly,
      extensions: [
        ...(latest.current.extensions ?? markdownExtensions(latest.current.placeholder)),
        maxLength,
      ],
      editorProps: {
        ...latest.current.editorProps,
        attributes: {
          class: "bb-markdown-prose",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": latest.current["aria-label"],
          ...(latest.current.id ? { id: latest.current.id } : {}),
          ...(latest.current["aria-describedby"]
            ? { "aria-describedby": latest.current["aria-describedby"]! }
            : {}),
          ...(latest.current["aria-keyshortcuts"]
            ? { "aria-keyshortcuts": latest.current["aria-keyshortcuts"]! }
            : {}),
          ...latest.current.editorProps?.attributes,
        },
      },
      transformIn: (text) => latest.current.transformIn?.(text) ?? text,
      transformOut: (text) => latest.current.transformOut?.(text) ?? text,
    });
    editorRef.current = editor;
    sessionRef.current = session;
    if (session.hasHiddenContent()) {
      inspect(splitEditableDocument(current.current).body, true);
      setMode("source");
    }
    editor.on("update", () => {
      const next = session.getMarkdown();
      if (next === splitEditableDocument(current.current).body) return;
      setLimit(false);
      changeBody(next);
    });
    latest.current.onEditor?.(editor);
    if (focusOnMount.current && !latest.current.readOnly) {
      editor.view.focus();
      focusOnMount.current = false;
    }
    return () => {
      latest.current.onEditor?.(null);
      editorRef.current = null;
      sessionRef.current = null;
      editor.destroy();
    };
    // Content synchronizes below; changing modes defines the editor lifetime.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [rich]);
  useEffect(() => {
    const body = splitEditableDocument(props.value).body;
    sessionRef.current?.load(body);
    // Inspect external loads and source edits, never an editor's own output.
    if (!rich || props.value !== emitted.current) {
      const hidden = sessionRef.current?.hasHiddenContent() ?? false;
      inspect(body, hidden);
      if (hidden) setMode("source");
    }
    // rich changes are lifetime changes, not external loads.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [props.value]);
  useEffect(() => {
    editorRef.current?.setEditable(!props.readOnly, false);
  }, [props.readOnly]);
  const sourceProps = {
    value: document.body,
    onChange: (body: string) => {
      setMode("source");
      changeBody(body);
    },
    onSave: () => latest.current.onSave?.(),
  };
  return (
    // Delegate shortcuts before ProseMirror's HardBreak bindings run.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <fieldset
      aria-label={`${props["aria-label"]} editor`}
      ref={root}
      className={`bb-markdown-editor ${props.className ?? ""}`}
      onFocusCapture={() => {
        focused.current = true;
      }}
      onKeyDownCapture={(event) => {
        props.onKeyDown?.(event);
        if (
          !event.defaultPrevented &&
          props.onSave &&
          (event.ctrlKey || event.metaKey) &&
          event.key === "s"
        ) {
          event.preventDefault();
          props.onSave();
        }
        if (event.defaultPrevented) event.stopPropagation();
      }}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        const owner = event.currentTarget;
        queueMicrotask(() => {
          if (focused.current && !owner.contains(window.document.activeElement)) {
            focused.current = false;
            latest.current.onBlur?.(current.current);
          }
        });
      }}
    >
      {header && (
        <label className="bb-markdown-frontmatter">
          <span>Frontmatter</span>
          <textarea
            aria-label="Frontmatter"
            className="bb-markdown-editor-source"
            readOnly={props.readOnly}
            spellCheck={false}
            value={document.yaml}
            onChange={(event) => {
              const parts = splitEditableDocument(current.current);
              let yaml = parts.yaml.includes("\r\n")
                ? event.target.value.replace(/\r?\n/g, "\r\n")
                : event.target.value;
              if (yaml && !yaml.endsWith("\n"))
                yaml += parts.prefix.endsWith("\r\n") ? "\r\n" : "\n";
              change(parts.prefix + yaml + parts.suffix + parts.body);
            }}
          />
        </label>
      )}
      <div className="bb-markdown-editor-toolbar" role="toolbar" aria-label="Markdown editing mode">
        <button
          type="button"
          aria-pressed={mode === "rich" && !reason}
          disabled={!!reason}
          onClick={() => {
            focusOnMount.current = true;
            inspect(document.body, false);
            setMode("rich");
            editorRef.current?.view.focus();
          }}
        >
          Rich text
        </button>
        <button
          type="button"
          aria-pressed={mode === "source" || !!reason}
          onClick={() => setMode("source")}
        >
          Markdown source
        </button>
      </div>
      {reason && <p className="bb-markdown-editor-notice">{reason}</p>}
      {limit && (
        <p role="alert" className="bb-markdown-editor-notice">
          This edit exceeds the {props.maxLength} character Markdown limit.
        </p>
      )}
      {rich ? (
        <div ref={surface} className="bb-markdown-editor-surface" />
      ) : props.renderSource ? (
        props.renderSource(sourceProps)
      ) : (
        <textarea
          data-markdown-source=""
          id={props.id}
          aria-label={props["aria-label"]}
          aria-describedby={props["aria-describedby"]}
          aria-keyshortcuts={props["aria-keyshortcuts"]}
          className="bb-markdown-editor-source"
          value={document.body}
          placeholder={props.placeholder}
          readOnly={props.readOnly}
          maxLength={
            props.maxLength === undefined ? undefined : Math.max(0, props.maxLength - header.length)
          }
          onChange={(event) => {
            setMode("source");
            changeBody(
              document.body.includes("\r\n")
                ? event.target.value.replace(/\r?\n/g, "\r\n")
                : event.target.value,
            );
          }}
        />
      )}
    </fieldset>
  );
}
