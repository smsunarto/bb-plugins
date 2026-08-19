import type { TaskId, TweakableGroup } from "./contract.js";

export interface TweakableDefinition {
  readonly path: string;
  readonly title: string;
  readonly note?: string;
  readonly render?: boolean;
}

export interface TweakableGroupDefinition {
  readonly id: string;
  readonly title: string;
  readonly files: readonly TweakableDefinition[];
}

export interface TaskDefinition {
  readonly command: string;
  readonly summary: string;
}

export const staticGroups: readonly TweakableGroupDefinition[] = [
  {
    id: "agents",
    title: "Agent config",
    files: [
      {
        path: ".dotfiles/mcp.json",
        title: "MCP servers",
        note: "Renders into ~/.claude.json and ~/.codex/config.toml",
        render: true,
      },
      {
        path: ".dotfiles/.agents/instructions/shared.md",
        title: "Instructions: shared",
        note: "Renders into CLAUDE.md and AGENTS.md",
        render: true,
      },
      {
        path: ".dotfiles/.agents/instructions/claude.md",
        title: "Instructions: claude",
        note: "Renders into ~/.claude/CLAUDE.md",
        render: true,
      },
      {
        path: ".dotfiles/.agents/instructions/codex.md",
        title: "Instructions: codex",
        note: "Renders into ~/.codex/AGENTS.md",
        render: true,
      },
    ],
  },
  {
    id: "overlays",
    title: "Settings overlays",
    files: [
      {
        path: ".dotfiles/.claude/settings.overlay.json",
        title: "Claude settings overlay",
        note: "Re-imposed on the host-owned ~/.claude/settings.json",
        render: true,
      },
      {
        path: ".dotfiles/.codex/config.macos.overlay.toml",
        title: "Codex overlay (macOS)",
        note: "Re-imposed on the host-owned ~/.codex/config.toml",
        render: true,
      },
      {
        path: ".dotfiles/.codex/config.linux.overlay.toml",
        title: "Codex overlay (Linux)",
        note: "Re-imposed on the host-owned ~/.codex/config.toml",
        render: true,
      },
    ],
  },
  {
    id: "shell",
    title: "Shell",
    files: [
      { path: ".dotfiles/.config/fish/config.fish", title: "fish config" },
      { path: ".dotfiles/.config/starship.toml", title: "starship prompt" },
      { path: ".dotfiles/.gitconfig", title: ".gitconfig" },
    ],
  },
  {
    id: "mise",
    title: "Mise",
    files: [
      {
        path: "mise.toml",
        title: "mise.toml",
        note: "Mappings, tasks, checks (portable only)",
      },
      {
        path: "mise.macos.toml",
        title: "mise.macos.toml",
        note: "Homebrew + macOS state",
      },
      {
        path: "mise.linux.toml",
        title: "mise.linux.toml",
        note: "apt + Linux-host state",
      },
      {
        path: ".miserc.toml",
        title: ".miserc.toml",
        note: "Enables platform-specific mise configuration",
      },
      {
        path: ".dotfiles/.config/mise/config.toml",
        title: "Global mise config",
        note: "The only [tools]/[env] declaration",
      },
    ],
  },
  {
    id: "repo",
    title: "Repo policy",
    files: [{ path: "AGENTS.md", title: "AGENTS.md", note: "Repository agent guide" }],
  },
];

export const taskDefinitions: Readonly<Record<TaskId, TaskDefinition>> = {
  render: {
    command: "mise run render",
    summary: "Render agent configs and settings overlays",
  },
  check: { command: "mise run check", summary: "Full repository validation" },
  "check:location": {
    command: "mise run check:location",
    summary: "Validate the canonical checkout path",
  },
  "check:mise": {
    command: "mise run check:mise",
    summary: "Validate mise and mappings",
  },
  "check:shell": {
    command: "mise run check:shell",
    summary: "Validate shell syntax",
  },
  "check:mcp": {
    command: "mise run check:mcp",
    summary: "Validate MCP JSON and renderer",
  },
  "check:python": {
    command: "mise run check:python",
    summary: "Validate the shared Python runtime and tools",
  },
  "check:skills": {
    command: "mise run check:skills",
    summary: "Validate skill manifests",
  },
  "check:dotfiles": {
    command: "mise run check:dotfiles",
    summary: "Validate dotfile mappings apply",
  },
  "check:safety": {
    command: "mise run check:safety",
    summary: "Reject unsafe forced apply workflows",
  },
  "check:secrets": {
    command: "mise run check:secrets",
    summary: "Reject legacy tracked secret injection",
  },
  "apply:dry": {
    command: "mise dotfiles apply --dry-run --verbose",
    summary: "Preview dotfile application",
  },
  "sync:pull": {
    command: "mise run sync:pull",
    summary: "Consume-only sync (fast-forward and apply)",
  },
};

export const publishTask: TaskDefinition = {
  command: "mise run sync",
  summary: "Publish: rebase, push, re-apply, and render",
};

export function groupDefinitions(
  skills: readonly TweakableDefinition[],
): readonly TweakableGroupDefinition[] {
  return [...staticGroups, { id: "skills", title: "Skills", files: skills }];
}

export function isAllowedPath(path: string, skills: readonly TweakableDefinition[]): boolean {
  return groupDefinitions(skills).some((group) => group.files.some((file) => file.path === path));
}

export function needsRender(path: string): boolean {
  return staticGroups.some((group) =>
    group.files.some((file) => file.path === path && file.render === true),
  );
}

export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

export function toOverviewGroup(
  group: TweakableGroupDefinition,
  exists: (path: string) => boolean,
  dirtyPaths: ReadonlySet<string>,
): TweakableGroup {
  return {
    id: group.id,
    title: group.title,
    files: group.files.map((file) => ({
      ...file,
      exists: exists(file.path),
      dirty: dirtyPaths.has(file.path),
    })),
  };
}
