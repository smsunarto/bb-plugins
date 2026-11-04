import { screenParameters } from "../../../.storybook/layout";
import { ready, shows } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { nav } from "../../../.storybook/surfaces";
import { resetCatalogDraftsForTest } from "../src/catalog/app/state";

const source = () => import("../src/app/app");
const sha = (char: string) => char.repeat(64);
const report = {
  linked: [],
  relinked: [],
  unlinked: [],
  unchanged: 3,
  agentsMd: "unchanged",
  conflicts: ["skills/review"],
  failed: [],
  deferred: [],
  removed: 0,
};
const skillMd = `---
name: dev
description: Engineering workflow with explicit principle reading and decision evidence.
---

# Dev

Read the principle before the decision it governs. Report the decisions it changed.
`;
const listing = {
  revision: 12,
  docs: [
    {
      id: "doc_shared",
      name: "Shared",
      enabled: true,
      origin: { kind: "imported", from: "instructions/shared.md" },
      characters: 1840,
      sha256: sha("d"),
    },
    {
      id: "doc_codex",
      name: "Codex notes",
      enabled: false,
      origin: { kind: "authored" },
      characters: 210,
      sha256: sha("e"),
    },
  ],
  skills: [
    {
      name: "dev",
      description: "Engineering workflow",
      enabled: true,
      origin: { kind: "authored" },
      treeSha: sha("a"),
      files: [
        { path: "SKILL.md", executable: false, size: skillMd.length, text: true },
        { path: "references/principles.md", executable: false, size: 900, text: true },
        { path: "scripts/check.sh", executable: true, size: 120, text: true },
      ],
    },
    {
      name: "mcp",
      description: "My MCP notes",
      enabled: true,
      origin: { kind: "imported", from: "skills/mcp" },
      treeSha: sha("b"),
      files: [{ path: "SKILL.md", executable: false, size: 300, text: true }],
    },
    {
      name: "review",
      description: "Review checklist",
      enabled: false,
      origin: { kind: "imported", from: "skills/review" },
      treeSha: sha("c"),
      files: [{ path: "SKILL.md", executable: false, size: 300, text: true }],
    },
  ],
  deleted: [{ kind: "doc", key: "doc_old", name: "Old rules", at: 1 }],
  published: {
    ok: true,
    at: 1,
    report,
    problems: [
      "skills/review already exists and this plugin did not make it, so it was left alone",
    ],
    warnings: [],
  },
};
const rpc = {
  catalog: () => listing,
  catalogShadows: () => ({ checked: true, shadows: [{ name: "mcp", owner: "plugin bb-guide" }] }),
  catalogFile: (input: { doc?: string; path?: string }) => ({
    content: input.doc ? "Use bb's browser for web checks.\n" : skillMd,
    sha256: sha("1"),
    size: skillMd.length,
    executable: false,
  }),
  changeCatalog: () => ({ outcome: "conflict", message: "Changed elsewhere" }),
  publishCatalog: () => listing.published,
};
const meta = {
  beforeEach: () => resetCatalogDraftsForTest(),
  play: ready,
  title: "Screens/Agent Instructions/Global catalog",
  component: RegisteredSurface,
  args: { source, select: (app) => nav(app, "global/skills/dev/SKILL.md", "sidebar") },
  parameters: {
    ...screenParameters,
    editorContext: { placement: "sidebar", title: "Agent instructions" },
    host: { pluginId: "agent-instructions", rpc },
  },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Sidebar: Story = { play: shows("Recently deleted") };
export const SkillFile: Story = {
  parameters: { editorContext: { placement: "page", title: "Agent instructions" } },
  args: { select: (app) => nav(app, "global/skills/dev/SKILL.md") },
};
export const ShadowedSkill: Story = {
  parameters: { editorContext: { placement: "page", title: "Agent instructions" } },
  args: { select: (app) => nav(app, "global/skills/mcp/SKILL.md") },
  play: shows(/bb also delivers a skill named mcp/),
};
export const Doc: Story = {
  parameters: { editorContext: { placement: "page", title: "Agent instructions" } },
  args: { select: (app) => nav(app, "global/docs/doc_shared") },
};
export const Overview: Story = {
  parameters: { editorContext: { placement: "page", title: "Agent instructions" } },
  args: { select: (app) => nav(app, "global") },
  play: shows("Instructions and skills for every agent"),
};
export const Loading: Story = {
  parameters: {
    host: {
      pluginId: "agent-instructions",
      rpc: { ...rpc, catalog: () => new Promise(() => {}) },
    },
  },
};
export const Error: Story = {
  play: shows("Catalog unavailable"),
  parameters: {
    host: {
      pluginId: "agent-instructions",
      rpc: { ...rpc, catalog: () => Promise.reject(new globalThis.Error("Catalog unavailable")) },
    },
  },
};
