import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  canvasStateSchema,
  stateChannel,
  stateKeyOf,
  type CanvasSource,
  type CanvasState,
  type JsonValue,
  type StateSignal,
} from "../shared/document.ts";

const emptyState: CanvasState = { values: {}, revision: 0 };

export function kvKeyOf(source: CanvasSource): string {
  return `canvas:state:${stateKeyOf(source)}`;
}

export async function readState(bb: BbPluginApi, source: CanvasSource): Promise<CanvasState> {
  const raw = await bb.storage.kv.get<unknown>(kvKeyOf(source));
  const parsed = canvasStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyState;
}

function publish(bb: BbPluginApi, source: CanvasSource, revision: number): StateSignal {
  const signal: StateSignal = { stateKey: stateKeyOf(source), revision };
  bb.realtime.publish(stateChannel, signal);
  return signal;
}

export async function writeState(
  bb: BbPluginApi,
  source: CanvasSource,
  key: string,
  value: JsonValue,
): Promise<CanvasState> {
  const current = await readState(bb, source);
  if (JSON.stringify(current.values[key]) === JSON.stringify(value)) {
    return current;
  }
  const next: CanvasState = {
    values: { ...current.values, [key]: value },
    revision: current.revision + 1,
  };
  await bb.storage.kv.set(kvKeyOf(source), next);
  publish(bb, source, next.revision);
  return next;
}

export async function clearState(bb: BbPluginApi, source: CanvasSource): Promise<CanvasState> {
  const current = await readState(bb, source);
  await bb.storage.kv.delete(kvKeyOf(source));
  const next: CanvasState = { values: {}, revision: current.revision + 1 };
  publish(bb, source, next.revision);
  return next;
}
