import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { StyleName } from "../shared/styles.ts";
import type { CanvasSource } from "../shared/source.ts";
import { parseCanvas } from "../shared/parse.ts";
import { componentNames } from "../shared/registry.ts";
import { collectDiagnostics } from "../shared/walk.ts";
import { PaletteProvider } from "./charts.tsx";
import {
  CommentsProvider,
  CommentsToolbar,
  DocumentCommentComposer,
  ThreadCard,
  useComments,
} from "./comments.tsx";
import type { CanvasDocument } from "../shared/document.ts";
import { CanvasBoundary } from "./query-client.ts";
import { Nodes, ProblemBar } from "./render.tsx";
import { CanvasProvider, CanvasStateProvider, useCanvasState } from "./state.tsx";

export { componentNames as canvasComponentNames };
export { narrowSource } from "../shared/source.ts";
export type { CanvasSource } from "../shared/source.ts";
const WidgetStyle = createContext<StyleName>("default");

export function usesCanvasWidgets(markdown: string): boolean {
  const parsed = parseCanvas(markdown);
  return parsed.ok && parsed.document.nodes.some((node) => node.kind === "component");
}

function StateStatus() {
  const state = useCanvasState();
  if (state.error === null) return null;
  return (
    <div role="alert" className="px-3 py-2 text-sm text-destructive">
      {state.error}{" "}
      <button type="button" onClick={state.retry}>
        Retry
      </button>
    </div>
  );
}

export function CanvasWidgetsProvider(props: {
  source: CanvasSource;
  children: ReactNode;
  onShowSource?: () => void;
  active?: boolean;
  markdown?: string;
}) {
  const parsed = useMemo(
    () => (props.markdown ? parseCanvas(props.markdown) : null),
    [props.markdown],
  );
  return (
    <CanvasBoundary>
      <CanvasProvider
        source={props.source}
        path={props.source.path}
        onShowSource={props.onShowSource}
      >
        <PaletteProvider>
          <CanvasStateProvider enabled={props.active ?? true}>
            {(props.active ?? true) && <StateStatus />}
            {parsed && /\.canvas\.mdx$/i.test(props.source.path) && (
              <ProblemBar
                diagnostics={parsed.ok ? collectDiagnostics(parsed.document) : [parsed.diagnostic]}
              />
            )}
            <WidgetStyle.Provider value={parsed?.ok ? parsed.document.style : "default"}>
              {props.children}
            </WidgetStyle.Provider>
          </CanvasStateProvider>
        </PaletteProvider>
      </CanvasProvider>
    </CanvasBoundary>
  );
}

// MDXEditor supplies each JSX block as Markdown. The existing Canvas parser
// validates literal props and child policies before the widget receives them.
export function CanvasWidget({ markdown }: { markdown: string }) {
  const style = useContext(WidgetStyle);
  const parsed = useMemo(() => parseCanvas(markdown), [markdown]);
  if (!parsed.ok) return <div role="alert">{parsed.diagnostic.message}</div>;
  return (
    <div className="canvas-prose canvas-document" data-canvas-style={style} contentEditable={false}>
      <Nodes nodes={parsed.document.nodes} />
    </div>
  );
}

function CommentThreads({ document }: { document: CanvasDocument }) {
  const comments = useComments();
  const threads = [...comments.placement.byOffset.values()]
    .flat()
    .concat(comments.placement.detached)
    .filter((entry) => comments.showResolved || entry.thread.resolvedAtMs === null);
  return (
    <section aria-label="Canvas comments" className="border-t border-border p-4">
      <DocumentCommentComposer document={document} />
      <div className="mb-2 flex items-center gap-2 text-xs">
        <CommentsToolbar />
      </div>
      {threads.map((placed) => (
        <ThreadCard key={placed.thread.id} placed={placed} />
      ))}
    </section>
  );
}

export function CanvasComments({ markdown }: { markdown: string }) {
  const parsed = useMemo(() => parseCanvas(markdown), [markdown]);
  if (!parsed.ok) return null;
  return (
    <CommentsProvider document={parsed.document} pollIntervalMs={1500}>
      <CommentThreads document={parsed.document} />
    </CommentsProvider>
  );
}
