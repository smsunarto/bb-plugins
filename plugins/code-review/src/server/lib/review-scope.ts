import type { PluginAgentConfigurationContext as Session } from "@get-bb/plugin-sdk";

const quiet = new Set(["side-chat", "review"]);
const answering = /^(Arena|Review) \((Claude|Codex)\)(?: — .+)?$/;

/**
 * Authors own their pull requests: they start reviews and babysit them.
 * Answering children receive only their supplied brief.
 */
export function ownsPullRequests(session: Session): boolean {
  const { parentThreadId, title } = session.thread;
  return !(
    quiet.has(session.origin.pluginId ?? "") ||
    session.pluginMetadata.kind === "review" ||
    (parentThreadId && answering.test(title ?? ""))
  );
}

export function reviewSkills(session: Session): string[] {
  return ownsPullRequests(session) ? ["review", "babysit-pr"] : [];
}
