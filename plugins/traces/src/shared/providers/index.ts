import type { TraceAdapter } from "../model";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";

export const builtinAdapters: readonly TraceAdapter[] = Object.freeze([
  claudeCodeAdapter,
  codexAdapter,
]);

export function createAdapterRegistry(adapters: readonly TraceAdapter[]) {
  const byId = new Map<string, TraceAdapter>();
  for (const adapter of adapters) {
    if (!adapter.id.trim()) throw new Error("Trace adapter IDs must not be empty");
    if (byId.has(adapter.id)) throw new Error(`Duplicate trace adapter ID: ${adapter.id}`);
    byId.set(adapter.id, adapter);
  }
  const list = Object.freeze([...byId.values()]);
  return Object.freeze({
    lookup: (id: string): TraceAdapter | undefined => byId.get(id),
    list: (): readonly TraceAdapter[] => list,
  });
}
