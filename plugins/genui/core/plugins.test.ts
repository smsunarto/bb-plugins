import { describe, expect, it } from "vitest";
import { compile, evaluate, formatDiagnostics, initialState, toMarkdown } from "./index";
import { projectProblems, projectRequests, toMarkdownWithProject } from "./markdown";
import {
  parsePluginClaims,
  pluginRow,
  pluginRows,
  type PluginClaim,
  type PluginInfo,
} from "./plugins";
import { projectRequestKey, type ProjectResult } from "./project";
import type { UiNode } from "./types";

function roots(source: string): UiNode[] {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  return evaluate(result.program, initialState(result.program)).roots;
}

function plugin(id: string, overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    found: true,
    id,
    name: id,
    version: "0.1.0",
    icon: null,
    source: `path · ~/git/bb-plugins/plugins/${id}`,
    sourceNotice: null,
    status: "running",
    statusDetail: null,
    ...overrides,
  };
}

const claim = (
  id: string,
  action: PluginClaim["action"],
  note: string | null = null,
): PluginClaim => ({ id, action, note });

describe("parsePluginClaims", () => {
  it("reads id, action and note, folding case and spacing, keeping the first claim per id", () => {
    expect(
      parsePluginClaims([
        { id: " GenUI ", action: "Reloaded" },
        { id: "source-control", action: "not reloaded", note: " type-check fails " },
        { id: "genui", action: "removed" },
      ]),
    ).toEqual({
      ok: true,
      value: [
        claim("genui", "reloaded"),
        claim("source-control", "not-reloaded", "type-check fails"),
      ],
    });
  });

  it("says what is wrong with a list it can't read", () => {
    expect(parsePluginClaims("genui")).toMatchObject({ ok: false });
    expect(parsePluginClaims([])).toEqual({
      ok: false,
      error: "Plugins items must name at least one plugin",
    });
    expect(parsePluginClaims(["genui"])).toMatchObject({
      ok: false,
      error: expect.stringContaining("each needs a plugin id"),
    });
    expect(parsePluginClaims([{ id: "genui", action: "restarted" }])).toEqual({
      ok: false,
      error: 'Plugins items: "genui" needs action installed, reloaded, removed or not-reloaded',
    });
    expect(
      parsePluginClaims(
        Array.from({ length: 26 }, (_, index) => ({ id: `p${index}`, action: "reloaded" })),
      ),
    ).toEqual({
      ok: false,
      error: "Plugins takes at most 25 plugins",
    });
  });
});

describe("pluginRow", () => {
  it("agrees with a reload or install only while BB runs the plugin", () => {
    expect(pluginRow(claim("a", "reloaded"), plugin("a"))).toMatchObject({
      tone: "good",
      stateLabel: "Running",
      problem: null,
    });
    expect(pluginRow(claim("a", "installed"), plugin("a", { status: "starting" }))).toMatchObject({
      tone: "info",
      problem: null,
    });
    expect(pluginRow(claim("a", "reloaded"), plugin("a", { status: "disabled" }))).toMatchObject({
      tone: "warn",
      problem: "Disabled, so BB isn't running it.",
    });
    expect(
      pluginRow(
        claim("a", "reloaded"),
        plugin("a", { status: "error", statusDetail: "server.js threw at load" }),
      ),
    ).toMatchObject({
      tone: "bad",
      stateLabel: "Failed",
      problem: "server.js threw at load",
    });
    expect(pluginRow(claim("a", "installed"), { found: false, id: "a" })).toMatchObject({
      tone: "bad",
      stateLabel: "Not installed",
      problem: "BB has no plugin with this id.",
    });
  });

  it("agrees with a removal only once BB no longer has the plugin", () => {
    expect(pluginRow(claim("a", "removed"), { found: false, id: "a" })).toMatchObject({
      tone: "good",
      stateLabel: "Not installed",
      problem: null,
    });
    expect(pluginRow(claim("a", "removed"), plugin("a"))).toMatchObject({
      tone: "bad",
      stateLabel: "Running",
      problem: "Still installed.",
    });
  });

  it("warns on a plugin left unreloaded, and asks for the reason when none is given", () => {
    expect(pluginRow(claim("a", "not-reloaded", "type-check fails"), plugin("a"))).toMatchObject({
      tone: "warn",
      problem: null,
    });
    expect(pluginRow(claim("a", "not-reloaded"), plugin("a"))).toMatchObject({
      tone: "warn",
      problem: "No reason given.",
    });
  });

  it("reads an id BB's answer left out as not installed", () => {
    expect(
      pluginRows([claim("a", "reloaded"), claim("b", "reloaded")], [plugin("a")]).map(
        (row) => row.stateLabel,
      ),
    ).toEqual(["Running", "Not installed"]);
  });
});

describe("toMarkdown: Plugins", () => {
  const source = `Plugins([{id: "genui", action: "reloaded"}, {id: "source-control", action: "not-reloaded", note: "type-check fails"}, {id: "old", action: "removed"}, {id: "gone", action: "removed"}])`;

  it("asks BB for the plugins named, once", () => {
    expect(projectRequests(roots(`Card("x", [${source}, ${source}])`))).toEqual([
      { kind: "plugins", ids: ["genui", "source-control", "old", "gone"] },
    ]);
  });

  it("lists each claim beside BB's state, with what contradicts it", () => {
    const nodes = roots(source);
    const answer: ProjectResult = {
      ok: true,
      plugins: [
        plugin("genui", { name: "Generative UI", version: "0.3.2" }),
        plugin("source-control"),
        plugin("old", { status: "disabled" }),
        { found: false, id: "gone" },
      ],
      fetchedAt: 1,
    };
    const answers = new Map(
      projectRequests(nodes).map((request) => [projectRequestKey(request), answer] as const),
    );
    expect(toMarkdownWithProject(nodes, new Map(), answers)).toBe(`**Plugins**

- **Generative UI** (\`genui\`) v0.3.2 — Reloaded · 🟢 Running · path · ~/git/bb-plugins/plugins/genui
- **source-control** v0.1.0 — Not reloaded · 🟠 Running · path · ~/git/bb-plugins/plugins/source-control
  - type-check fails
- **old** v0.1.0 — Removed · 🔴 Disabled · path · ~/git/bb-plugins/plugins/old
  - Still installed.
- \`gone\` — Removed · 🟢 Not installed`);
  });

  it("keeps the claims when BB wasn't asked or couldn't answer", () => {
    expect(toMarkdown(roots(`Plugins([{id: "genui", action: "reloaded"}])`))).toBe(
      "**Plugins** · _as the reply reports; open it in BB for each plugin's status_\n\n- `genui` — Reloaded",
    );
    const nodes = roots(`Plugins([{id: "genui", action: "not-reloaded", note: "busy"}])`);
    const failure: ProjectResult = {
      ok: false,
      reason: "unavailable",
      message: "BB couldn't list its plugins: timeout",
    };
    const answers = new Map(
      projectRequests(nodes).map((request) => [projectRequestKey(request), failure] as const),
    );
    expect(toMarkdownWithProject(nodes, new Map(), answers)).toBe(
      "**Plugins** · _BB couldn't list its plugins: timeout_\n\n- `genui` — Not reloaded: busy",
    );
  });

  it("reports unreadable items to check_ui", () => {
    expect(projectProblems(roots(`Plugins([{id: "genui", action: "restarted"}])`))).toEqual([
      'Plugins items: "genui" needs action installed, reloaded, removed or not-reloaded',
    ]);
  });
});
