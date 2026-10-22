import type { Session } from "@bb-kit/core/tools";

const quiet = new Set(["side-chat", "review"]);
const answering = /^(Arena|Review) \((Claude|Codex)\)(?: — .+)?$/;

/** Authors can start reviews; answering children receive only their supplied brief. */
export function reviewSkills(_ctx: unknown, session: Session): string[] {
  const { parentThreadId, title } = session.thread;
  if (
    quiet.has(session.origin.pluginId ?? "") ||
    session.pluginMetadata.kind === "review" ||
    (parentThreadId && answering.test(title ?? ""))
  )
    return [];
  return ["review"];
}
