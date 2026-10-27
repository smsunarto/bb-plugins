import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  MAX_PROJECT_SCRIPTS,
  projectScriptsKey,
  projectScriptsOutputSchema,
  type ProjectScript,
  type ProjectScriptEdit,
} from "../../shared/thread-details.ts";

export async function readProjectScripts(
  bb: BbPluginApi,
  projectId: string,
): Promise<ProjectScript[]> {
  const stored = await bb.storage.kv.get<unknown>(projectScriptsKey(projectId));
  // A row from an older shape reads as no scripts rather than failing the card.
  const parsed = projectScriptsOutputSchema.safeParse({ scripts: stored ?? [] });
  return parsed.success ? parsed.data.scripts : [];
}

/** One edit at a time per project, so two clients' edits both land instead of the later list winning. */
const queues = new Map<string, Promise<unknown>>();

export function editProjectScripts(
  bb: BbPluginApi,
  projectId: string,
  edit: ProjectScriptEdit,
): Promise<ProjectScript[]> {
  const previous = queues.get(projectId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await readProjectScripts(bb, projectId);
      const scripts = applyEdit(current, edit);
      if (scripts.length === 0) await bb.storage.kv.delete(projectScriptsKey(projectId));
      else await bb.storage.kv.set(projectScriptsKey(projectId), scripts);
      return scripts;
    });
  queues.set(projectId, next);
  void next.finally(() => {
    if (queues.get(projectId) === next) queues.delete(projectId);
  });
  return next;
}

function applyEdit(current: ProjectScript[], edit: ProjectScriptEdit): ProjectScript[] {
  if (edit.kind === "delete") return current.filter((script) => script.id !== edit.scriptId);
  const index = current.findIndex((script) => script.id === edit.script.id);
  if (index >= 0) return current.map((script, at) => (at === index ? edit.script : script));
  if (current.length >= MAX_PROJECT_SCRIPTS)
    throw new Error(`A project keeps at most ${MAX_PROJECT_SCRIPTS} scripts.`);
  return [...current, edit.script];
}
