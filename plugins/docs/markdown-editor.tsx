import { usePublisher } from "@mdxeditor/gurx";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  CanvasWidgetsProvider,
  CanvasComments,
  usesCanvasWidgets,
  type CanvasSource,
} from "@smsunarto/bb-plugin-canvas/editor";
import "@smsunarto/bb-plugin-canvas/editor.css";
import {
  MDXEditor,
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
import { parseMarkdownDocument } from "./markdown-document.js";
import { ensureEditorStyles } from "./editor-styles.js";
import { preserveEsmPlugin } from "./mdx-esm.js";
import { canvasDescriptors } from "./canvas-editor.js";

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
  onUpload(file: File): Promise<{ markdownPath: string }>;
  onFirstRender(markdown: string): void;
  onMarkdownChange(markdown: string): void;
}

const SourceRequestContext = createContext(0);

function Toolbar() {
  const request = useContext(SourceRequestContext);
  const setView = usePublisher(viewMode$);
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

function EditorSession(props: MarkdownEditorProps) {
  const { initialValue, previewBaseUrl, notePath } = props;
  const hasCanvasSource = Boolean(props.canvasSource);
  const editorRef = useRef<MDXEditorMethods>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [sourceRequest, setSourceRequest] = useState(0);
  const [currentMarkdown, setCurrentMarkdown] = useState(initialValue);
  const canvasActive = useMemo(
    () =>
      /\.mdx$/i.test(notePath) &&
      (/\.canvas\.mdx$/i.test(notePath) || usesCanvasWidgets(currentMarkdown)),
    [currentMarkdown, notePath],
  );
  const document = useMemo(() => parseMarkdownDocument(initialValue), [initialValue]);
  const leadingBreaks = document.frontmatter ? (/^(?:\r?\n)*/.exec(document.body)?.[0] ?? "") : "";
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
          <section className="simple-html-embed" contentEditable={false}>
            <div className="simple-html-embed-header">{source}</div>
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
        imageUploadHandler: async (file) => (await callbacks.current.onUpload(file)).markdownPath,
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
        : []),
      directivesPlugin({
        directiveDescriptors: [
          html,
          {
            name: "directive",
            testNode: () => true,
            attributes: [],
            hasChildren: true,
            Editor: GenericDirectiveEditor,
          },
        ],
      }),
      diffSourcePlugin(),
      toolbarPlugin({ toolbarContents: Toolbar }),
      markdownShortcutPlugin(),
    ];
  }, [notePath, previewBaseUrl, hasCanvasSource]);

  useEffect(() => {
    // Initialization may normalize Markdown. Merely opening a file must never
    // write those changes back to disk.
    callbacks.current.onFirstRender(initialValue);
  }, [initialValue]);

  const editor = (
    <SourceRequestContext.Provider value={sourceRequest}>
      <MDXEditor
        ref={editorRef}
        markdown={document.body}
        contentEditableClassName="docs-prose"
        className="docs-mdx-editor"
        plugins={plugins}
        placeholder="Start writing…"
        toMarkdownOptions={{ bullet: "-", fences: true, listItemIndent: "one" }}
        onChange={(body, initialNormalize) => {
          if (!initialNormalize) {
            const markdown = document.frontmatter + leadingBreaks + body;
            setCurrentMarkdown(markdown);
            callbacks.current.onMarkdownChange(markdown);
          }
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
      {editor}
      {canvasActive && <CanvasComments markdown={currentMarkdown} />}
    </CanvasWidgetsProvider>
  ) : (
    editor
  );
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  useEffect(ensureEditorStyles, []);
  return (
    <div className="bb-simple-notes-editor min-h-0 flex-1 overflow-y-auto">
      <EditorSession
        key={`${props.notePath}:${props.previewBaseUrl}:${props.initialValue}`}
        {...props}
      />
    </div>
  );
}
