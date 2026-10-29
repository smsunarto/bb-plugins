/** Dotfiles keeps source shortcuts; all instruction editing belongs to Agent Instructions. */
export function instructionLink(path: string, hostId: string, rootPath: string): string | null {
  const global =
    path.startsWith(".dotfiles/.agents/instructions/") ||
    path.startsWith(".dotfiles/.agents/skills/") ||
    path.startsWith(".dotfiles/.agents/plugins/");
  if (!global && path !== "AGENTS.md") return null;
  return `/plugins/agent-instructions/instructions/${global ? "global" : "projects"}/at/${encodeURIComponent(hostId)}/${encodeURIComponent(rootPath)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
