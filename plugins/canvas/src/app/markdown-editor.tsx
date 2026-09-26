import { useCellValues, usePublisher } from "@mdxeditor/gurx";
import { EditorView } from "@codemirror/view";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MDXEditor,
  addSyntaxExtension$,
  realmPlugin,
  markdownProcessingError$,
  viewMode$,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  CreateLink,
  DiffSourceToggleWrapper,
  GenericDirectiveEditor,
  GenericJsxEditor,
  InsertCodeBlock,
  InsertImage,
  InsertTable,
  ListsToggle,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  directivesPlugin,
  headingsPlugin,
  imagePlugin,
  jsxPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  type DirectiveDescriptor,
  type MDXEditorMethods,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import type { CanvasSource } from "../shared/source.ts";
import {
  CanvasReview,
  CanvasWidgetsProvider,
  canvasDescriptors,
  usesCanvasWidgets,
} from "./editor.tsx";
import { parseMarkdownDocument } from "./markdown-document.ts";
import { preserveEsmPlugin } from "./mdx-esm.tsx";
import "./app.css";
import "./markdown-editor.css";

export function previewUrl(baseUrl: string, notePath: string, source: string): string {
  if (/^(https?:|data:|blob:|#)/i.test(source)) return source;
  const directory = notePath.slice(0, notePath.lastIndexOf("/") + 1);
  const parts = source.startsWith("/") ? [] : directory.split("/").filter(Boolean);
  for (const part of source.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `${baseUrl}/${parts.map(encodeURIComponent).join("/")}`;
}

export interface MarkdownEditorProps {
  initialValue: string;
  previewBaseUrl: string;
  notePath: string;
  canvasSource?: CanvasSource;
  onUpload?(file: File): Promise<{ markdownPath: string }>;
  onFirstRender(markdown: string): void;
  onMarkdownChange(markdown: string): void;
  onProposalApplied(result: { content: string; sha256: string }): void;
}

// Plain Markdown permits unpaired angle-bracket placeholders. Disable both
// JSX-style HTML processing and CommonMark HTML tokenization so they stay text.
const literalHtmlPlugin = realmPlugin({
  init(realm) {
    realm.pub(addSyntaxExtension$, { disable: { null: ["htmlFlow", "htmlText"] } });
  },
});

const SourceRequestContext = createContext(0);

function Toolbar() {
  const request = useContext(SourceRequestContext);
  const setView = usePublisher(viewMode$);
  const [parseError, viewMode] = useCellValues(markdownProcessingError$, viewMode$);
  useEffect(() => {
    // A failed rich-text import must leave the complete source editable.
    // Re-check on each mode change so an unsuccessful retry returns to source.
    if (parseError && viewMode === "rich-text") setView("source");
  }, [parseError, viewMode, setView]);
  useEffect(() => {
    if (request > 0) setView("source");
  }, [request, setView]);
  return (
    <DiffSourceToggleWrapper options={["rich-text", "source"]}>
      <UndoRedo />
      <BlockTypeSelect />
      <BoldItalicUnderlineToggles />
      <ListsToggle />
      <CreateLink />
      <InsertImage />
      <InsertTable />
      <InsertCodeBlock />
    </DiffSourceToggleWrapper>
  );
}

function EditorSession(
  props: MarkdownEditorProps & {
    reviewTab: "comments" | "edits";
    onReviewTabChange(tab: "comments" | "edits"): void;
  },
) {
  const { initialValue, previewBaseUrl, notePath } = props;
  const hasCanvasSource = Boolean(props.canvasSource);
  const hasUpload = Boolean(props.onUpload);
  const editorRef = useRef<MDXEditorMethods>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [sourceRequest, setSourceRequest] = useState(0);
  const [currentMarkdown, setCurrentMarkdown] = useState(initialValue);
  const [applying, setApplying] = useState(false);
  const canvasActive = useMemo(
    () =>
      /\.mdx$/i.test(notePath) &&
      (/\.canvas\.mdx$/i.test(notePath) || usesCanvasWidgets(currentMarkdown)),
    [currentMarkdown, notePath],
  );
  const document = useMemo(() => parseMarkdownDocument(initialValue), [initialValue]);
  const leadingBreaks = document.frontmatter ? (/^(?:\r?\n)*/.exec(document.body)?.[0] ?? "") : "";
  // MDXEditor drops the final newline. Keep the file's own ending so a save
  // does not add a "No newline at end of file" diff.
  const finalBreaks = /(?:\r?\n)*$/.exec(initialValue)?.[0] ?? "";
  const lastPublished = useRef(initialValue);
  const publishBody = useCallback(
    (body: string) => {
      const markdown =
        document.frontmatter + leadingBreaks + body.replace(/(?:\r?\n)*$/, "") + finalBreaks;
      if (markdown === lastPublished.current) return;
      lastPublished.current = markdown;
      setCurrentMarkdown(markdown);
      callbacks.current.onMarkdownChange(markdown);
    },
    [document.frontmatter, leadingBreaks, finalBreaks],
  );
  const plugins = useMemo(() => {
    const html: DirectiveDescriptor = {
      name: "html",
      testNode: (node) => node.name === "html" && node.type === "leafDirective",
      attributes: ["src", "height"],
      hasChildren: false,
      Editor: ({ mdastNode }) => {
        const source = mdastNode.attributes?.src ?? "";
        const height = Math.min(1200, Math.max(120, Number(mdastNode.attributes?.height) || 360));
        return (
          <section className="canvas-html-embed" contentEditable={false}>
            <div className="canvas-html-embed-header">{source}</div>
            <iframe
              title={`Embedded HTML: ${source}`}
              sandbox="allow-scripts"
              style={{ height }}
              src={previewUrl(previewBaseUrl, notePath, source)}
            />
          </section>
        );
      },
    };
    return [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      linkPlugin(),
      linkDialogPlugin(),
      tablePlugin(),
      imagePlugin({
        imagePreviewHandler: async (source) => previewUrl(previewBaseUrl, notePath, source),
        ...(hasUpload
          ? {
              imageUploadHandler: async (file: File) =>
                (await callbacks.current.onUpload!(file)).markdownPath,
            }
          : {}),
      }),
      codeBlockPlugin({ defaultCodeBlockLanguage: "text" }),
      codeMirrorPlugin({
        codeBlockLanguages: {
          text: "Plain text",
          js: "JavaScript",
          ts: "TypeScript",
          tsx: "TSX",
          jsx: "JSX",
          json: "JSON",
          bash: "Shell",
          css: "CSS",
          html: "HTML",
          python: "Python",
          go: "Go",
          csharp: "C#",
          yaml: "YAML",
          sql: "SQL",
          markdown: "Markdown",
        },
      }),
      ...(/\.(mdx)$/i.test(notePath)
        ? [
            jsxPlugin({
              jsxComponentDescriptors: [
                ...(hasCanvasSource ? canvasDescriptors : []),
                { name: "*", kind: "flow", props: [], hasChildren: true, Editor: GenericJsxEditor },
              ],
            }),
            preserveEsmPlugin(),
          ]
        : [literalHtmlPlugin()]),
      directivesPlugin({
        escapeUnknownTextDirectives: true,
        directiveDescriptors: [
          html,
          {
            name: "directive",
            // Bare :words occur in CLI commands, paths, and prose. Only
            // structured inline directives need the generic widget editor.
            testNode: (node) =>
              node.type !== "textDirective" ||
              node.children.length > 0 ||
              Object.keys(node.attributes ?? {}).length > 0,
            attributes: [],
            hasChildren: true,
            Editor: GenericDirectiveEditor,
          },
        ],
      }),
      diffSourcePlugin({
        codeMirrorExtensions: [
          EditorView.updateListener.of((update) => {
            // Failed initial imports leave MDXEditor's normalization flag set.
            // Actual source edits must still save, but focus/selection must not.
            if (update.docChanged) publishBody(update.state.doc.toString());
          }),
        ],
      }),
      toolbarPlugin({ toolbarContents: Toolbar }),
      markdownShortcutPlugin(),
    ];
  }, [notePath, previewBaseUrl, hasCanvasSource, hasUpload, publishBody]);

  useEffect(() => {
    // Initialization may normalize Markdown. Merely opening a file must never
    // write those changes back to disk.
    callbacks.current.onFirstRender(initialValue);
  }, [initialValue]);

  const editor = (
    <SourceRequestContext.Provider value={sourceRequest}>
      <MDXEditor
        ref={editorRef}
        readOnly={applying}
        markdown={document.body}
        suppressHtmlProcessing={!/\.mdx$/i.test(notePath)}
        contentEditableClassName="canvas-prose canvas-mdx-prose"
        className="canvas-mdx-editor"
        plugins={plugins}
        placeholder="Start writing…"
        toMarkdownOptions={{ bullet: "-", fences: true, listItemIndent: "one" }}
        onChange={(body, initialNormalize) => {
          if (!initialNormalize) publishBody(body);
        }}
      />
    </SourceRequestContext.Provider>
  );
  return props.canvasSource && /\.mdx$/i.test(notePath) ? (
    <CanvasWidgetsProvider
      source={props.canvasSource}
      markdown={currentMarkdown}
      active={canvasActive}
      onShowSource={() => setSourceRequest((value) => value + 1)}
    >
      {canvasActive ? (
        <CanvasReview
          tab={props.reviewTab}
          onTabChange={props.onReviewTabChange}
          markdown={currentMarkdown}
          onApplying={setApplying}
          onApplied={(result) => {
            setCurrentMarkdown(result.content);
            callbacks.current.onProposalApplied(result);
          }}
        >
          {editor}
        </CanvasReview>
      ) : (
        editor
      )}
    </CanvasWidgetsProvider>
  ) : (
    editor
  );
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  const [reviewTab, setReviewTab] = useState<"comments" | "edits">("comments");
  return (
    <div className="canvas-scroll min-h-0 flex-1 overflow-y-auto">
      <EditorSession
        reviewTab={reviewTab}
        onReviewTabChange={setReviewTab}
        key={`${props.notePath}:${props.previewBaseUrl}:${props.initialValue}`}
        {...props}
      />
    </div>
  );
}
