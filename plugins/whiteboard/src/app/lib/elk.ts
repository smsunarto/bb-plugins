import Bundled, {
  type ELK as ElkApi,
  type ElkLayoutArguments,
  type ElkNode,
} from "elkjs/lib/elk.bundled.js";

export type { ElkNode, LayoutOptions } from "elkjs/lib/elk.bundled.js";

let shared: ElkApi | undefined;

/**
 * elk.bundled's constructor boots ELK's GWT runtime. bb imports every plugin
 * bundle at startup, and c4-layout-geometry.ts constructs an ELK at module
 * scope, so that boot cost landed on every bb launch. Every `ELK` here
 * delegates to one bundled instance, built on the first layout.
 * flow-graph.tsx and c4-layout-geometry.ts import this module (edit and
 * redirect rows).
 */
export default class ELK {
  layout<T extends ElkNode>(graph: T, args?: ElkLayoutArguments) {
    shared ??= new Bundled();
    return shared.layout(graph, args);
  }
}
