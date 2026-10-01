// Vendored from dev.fast review/app/src/call-tree.ts @4ecc570 (MIT).
import { frameIdentity } from "../../../../../shared/vendor/review/src/call-stack-frames.ts";
import type { DiffSelection } from "../../../../../shared/vendor/review/src/lens-selection.ts";
import type { LensSource } from "../../../../../shared/vendor/review/src/lens-selection.ts";
import type { CallStackDiffBlock } from "../../../../../shared/vendor/review/src/review-api/blocks/call_stack_diff.ts";

export interface CallTreeStop {
  id: string;
  label: string;
  source: DiffSelection;
  anchorId: string;
  sources: LensSource[];
  parentId?: string;
  callSite?: DiffSelection;
  via?: string;
  depth: number;
  branches: boolean[];
  last: boolean;
}

/** Adapt authored frames to the experimental sidebar's presentation contract. */
export function callTreeStops(block: CallStackDiffBlock): CallTreeStop[] {
  const nodes = new Map<
    string,
    Omit<CallTreeStop, "depth" | "branches" | "last">
  >();

  for (const side of ["head", "base"] as const) {
    let previous: string | undefined;

    for (const [index, frame] of block[side].entries()) {
      const id = `${block.id}:${frame.key ?? `${side}:${index}`}`;
      const existing = nodes.get(id);

      if (existing)
        existing.sources.push(
          frame.source,
          ...(frame.contextSources ?? []),
          ...(frame.callSite ? [frame.callSite] : []),
        );
      else
        nodes.set(id, {
          id,
          source: frame.source,
          anchorId: frame.id ?? frameIdentity(frame),
          label: frame.label ?? frame.source.file.split("/").pop()!,
          sources: [
            frame.source,
            ...(frame.contextSources ?? []),
            ...(frame.callSite ? [frame.callSite] : []),
          ],
          parentId:
            frame.parentKey === null
              ? undefined
              : frame.parentKey
                ? `${block.id}:${frame.parentKey}`
                : previous,
          callSite: frame.callSite,
          via: frame.via?.reason,
        });
      previous = id;
    }
  }

  const result: CallTreeStop[] = [];

  const walk = (
    parentId: string | undefined,
    depth: number,
    branches: boolean[],
  ) => {
    const children = [...nodes.values()].filter(
      (node) => node.parentId === parentId,
    );

    children.forEach((node, index) => {
      const last = index === children.length - 1;
      result.push({ ...node, depth, branches, last });
      walk(node.id, depth + 1, [...branches, !last]);
    });
  };

  walk(undefined, 0, []);

  return result;
}
