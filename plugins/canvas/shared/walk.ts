import type { CanvasDocument, CanvasNode, Diagnostic } from "./document.ts";
import { isStatefulName } from "./source.ts";

// Zod-free tree walks so the app can import them as values.

export function collectDiagnostics(document: CanvasDocument): readonly Diagnostic[] {
  const out: Diagnostic[] = [];
  const walk = (nodes: readonly CanvasNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "diagnostic") {
        out.push(node.diagnostic);
      } else if (node.kind === "component") {
        walk(node.children);
      }
    }
  };
  walk(document.nodes);
  return out;
}

export function collectStateIds(nodes: readonly CanvasNode[]): readonly string[] {
  const out: string[] = [];
  const walk = (list: readonly CanvasNode[]): void => {
    for (const node of list) {
      if (node.kind !== "component") continue;
      const id = node.props["id"];
      if (isStatefulName(node.name) && typeof id === "string") {
        out.push(id);
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
