import type { ReactElement, ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { CanvasNode, Diagnostic } from "../shared/document.ts";
import { buttonClass, componentTable } from "./components.tsx";
import { keyed } from "./keys.ts";
import { useCanvas } from "./state.tsx";

export function positionOf(diagnostic: Diagnostic): string | null {
  return diagnostic.span === null ? null : `${diagnostic.span.line}:${diagnostic.span.column}`;
}

export function useShowSource(): () => void {
  const canvas = useCanvas();
  return () => canvas.setView("source");
}

export function ProblemCard(props: { readonly diagnostic: Diagnostic }): ReactElement {
  const showSource = useShowSource();
  const position = positionOf(props.diagnostic);
  return (
    <div
      role="alert"
      className="my-3 rounded-md border border-dashed border-red-500/50 bg-red-500/5 px-3 py-2 text-sm"
    >
      <p className="m-0 flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-xs text-muted-foreground">{props.diagnostic.code}</span>
        {position !== null ? (
          <span className="font-mono text-xs text-muted-foreground">{position}</span>
        ) : null}
        <span className="text-foreground">{props.diagnostic.message}</span>
      </p>
      <button type="button" className={`mt-2 ${buttonClass}`} onClick={showSource}>
        Show source
      </button>
    </div>
  );
}

export function ProblemBar(props: {
  readonly diagnostics: readonly Diagnostic[];
}): ReactElement | null {
  const showSource = useShowSource();
  if (props.diagnostics.length === 0) return null;
  const count = props.diagnostics.length;
  return (
    <div className="border-b border-border bg-red-500/5 px-3 py-2 text-sm">
      <p className="m-0 mb-1 font-medium text-red-600 dark:text-red-400">
        {count} problem{count === 1 ? "" : "s"}
      </p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {keyed(props.diagnostics, (d) => `${positionOf(d) ?? ""}:${d.message}`).map(
          ({ key, item: diagnostic }) => {
            const position = positionOf(diagnostic);
            return (
              <li key={key}>
                <button
                  type="button"
                  className="text-left text-foreground hover:underline"
                  onClick={showSource}
                >
                  {position !== null ? (
                    <span className="font-mono text-xs text-muted-foreground">{position} </span>
                  ) : null}
                  {diagnostic.message}
                </button>
              </li>
            );
          },
        )}
      </ul>
    </div>
  );
}

function nodeKey(node: CanvasNode): string {
  switch (node.kind) {
    case "markdown":
      return `md:${node.span.startOffset}`;
    case "component":
      return `${node.name}:${node.span.startOffset}`;
    case "diagnostic":
      return `diag:${node.diagnostic.span?.startOffset ?? -1}:${node.diagnostic.code}`;
  }
}

export function renderNodes(nodes: readonly CanvasNode[]): ReactNode {
  return keyed(nodes, nodeKey).map((entry) => <Node key={entry.key} node={entry.item} />);
}

function Node(props: { readonly node: CanvasNode }): ReactElement {
  const { node } = props;
  switch (node.kind) {
    case "markdown":
      return <Markdown content={node.source} />;
    case "diagnostic":
      return <ProblemCard diagnostic={node.diagnostic} />;
    case "component": {
      const Component = componentTable[node.name];
      return <Component props={node.props} nodes={node.children} renderNodes={renderNodes} />;
    }
  }
}

export function Nodes(props: { readonly nodes: readonly CanvasNode[] }): ReactElement {
  return <>{renderNodes(props.nodes)}</>;
}
