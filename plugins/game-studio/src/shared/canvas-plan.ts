import type { Board, CanvasNode } from "./schema.ts";
import { nodeRefs } from "./inputs.ts";
import { nodeInputs, nodeRecipe, nodeTakesBrief } from "./recipes.ts";

/*
 * Running a node runs what it is missing first. The plan walks the node's inputs: an input
 * with an output is used as it is, however old; one without an output is run, and its own
 * inputs are walked the same way. Outputs a person approves before a step consumes them
 * (a Tripo front view, a UV candidate) stop the walk: the run makes them, then waits for
 * the person. The UI shows the same plan the server dispatches.
 */

/** Whether a node has an output other nodes can consume now. A picked file may still be gone. */
export function hasOutput(node: Pick<CanvasNode, "type" | "data">): boolean {
  switch (node.type) {
    case "text":
      return typeof node.data.text === "string" && node.data.text.trim() !== "";
    case "document":
      return typeof node.data.documentId === "string" && node.data.documentId !== "";
    case "table":
      return true;
    default:
      return typeof node.data.assetId === "string" && node.data.assetId !== "";
  }
}

/** The nodes feeding a node, once each, in connection order. */
export function inputNodeIds(node: Pick<CanvasNode, "data">): string[] {
  return [
    ...new Set(
      nodeRefs(node).flatMap((ref) =>
        ref.type === "node" && typeof ref.nodeId === "string" ? [ref.nodeId] : [],
      ),
    ),
  ];
}

export type PlanGate = { nodeId: string; port: string; sourceId: string };
export type PlanIssue = { nodeId: string; message: string };
export type RunPlan = {
  /** Nodes without an output that the target needs, inputs first. */
  missing: string[];
  /** The nodes this run makes, inputs first, ending with the target unless a gate stops it. */
  queue: string[];
  /** The first step whose approved input this run would have made. */
  gate?: PlanGate;
  /** What keeps a queued node from running at all. */
  issues: PlanIssue[];
};

const title = (node: CanvasNode) => node.title || node.type;

/** Why a node cannot run as it is saved, if anything. */
function issue(
  node: CanvasNode,
  kindOf: (id: string) => CanvasNode["type"] | undefined,
): string | undefined {
  const name = title(node);
  if (node.type === "asset")
    return hasOutput(node)
      ? `Audio node “${name}” is imported, not generated here.`
      : `Audio node “${name}” has no output. Import one, or ask the agent to generate it.`;
  if (node.type === "document") return `Document node “${name}” has no document selected.`;
  if (node.type === "table") return undefined;
  const ports = nodeInputs(node, kindOf);
  const empty = ports.find(({ port, refs }) => port.required && !refs.length);
  if (empty) return `“${name}” needs a ${empty.port.label} input.`;
  const instruction = typeof node.data.instruction === "string" ? node.data.instruction.trim() : "";
  if (node.type === "text" && !instruction)
    return hasOutput(node)
      ? `Tell the agent what to write in “${name}”.`
      : `Note “${name}” is empty. Write it, or write an instruction for the agent.`;
  if (node.type === "agent" && !instruction) return `Agent step “${name}” needs an instruction.`;
  const prompt = typeof node.data.prompt === "string" ? node.data.prompt.trim() : "";
  const linkedText = ports.some(({ port, refs }) => port.type === "text" && refs.length > 0);
  if (
    (node.type === "image" || node.type === "video") &&
    nodeTakesBrief(node) &&
    !prompt &&
    !linkedText
  )
    return `Write a brief for “${name}”.`;
  return undefined;
}

/** The run a node's Run button starts: its missing inputs, then the node. */
export function planRun(
  board: Pick<Board, "nodes">,
  targetId: string,
  hasOutputNow: (node: CanvasNode) => boolean = hasOutput,
): RunPlan {
  const nodes = new Map(board.nodes.map((node) => [node.id, node]));
  const kindOf = (id: string) => nodes.get(id)?.type;
  const target = nodes.get(targetId);
  if (!target) throw new Error("The canvas node no longer exists.");
  const missing: string[] = [];
  const issues: PlanIssue[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (node: CanvasNode) => {
    visiting.add(node.id);
    for (const id of inputNodeIds(node)) {
      const other = nodes.get(id);
      if (!other || done.has(id) || hasOutputNow(other)) continue;
      // A loop through a node with an output refines it; one without an output never starts.
      if (visiting.has(id)) {
        issues.push({ nodeId: id, message: `“${title(other)}” feeds itself through its inputs.` });
        continue;
      }
      visit(other);
      missing.push(other.id);
    }
    visiting.delete(node.id);
    done.add(node.id);
  };
  visit(target);
  const order = [...missing, targetId];
  const inPlan = new Set(missing);
  // A step behind a gate waits for a person; so does everything that needs it.
  const blocked = new Set<string>();
  let gate: PlanGate | undefined;
  for (const id of order) {
    const node = nodes.get(id)!;
    const inputs = inputNodeIds(node);
    if (inputs.some((input) => blocked.has(input))) {
      blocked.add(id);
      continue;
    }
    for (const port of nodeRecipe(node)?.gates ?? []) {
      const ref = nodeInputs(node, kindOf).find((item) => item.port.id === port)?.refs[0];
      const sourceId =
        ref?.type === "node" && typeof ref.nodeId === "string" ? ref.nodeId : undefined;
      if (!sourceId || !inPlan.has(sourceId)) continue;
      blocked.add(id);
      gate ??= { nodeId: id, port, sourceId };
      break;
    }
  }
  const queue = order.filter((id) => !blocked.has(id));
  for (const id of queue) {
    const message = issue(nodes.get(id)!, kindOf);
    if (message) issues.push({ nodeId: id, message });
  }
  return { missing, queue, ...(gate ? { gate } : {}), issues };
}

/** Whether every node feeding this one has an output now. */
export function inputsReady(
  board: Pick<Board, "nodes">,
  node: CanvasNode,
  hasOutputNow: (node: CanvasNode) => boolean = hasOutput,
): boolean {
  return inputNodeIds(node).every((id) => {
    const other = board.nodes.find((item) => item.id === id);
    return !other || hasOutputNow(other);
  });
}
