import { parseCatalogRoute } from "../catalog/app/state.ts";
import { parseDocumentRoute } from "../documents/app.tsx";
import { parsePromptSelection } from "../prompts/app/app.tsx";
import { parseRulesRoute, RULES_ROUTE } from "./rules.tsx";

/** Where the page is: which editor, and whether a file, doc, rule, or tool is open. */
export type Section = "global" | "projects" | "prompts";
export interface Location {
  section: Section;
  /** False at an editor's root, where a phone shows the list the sidebar holds on desktop. */
  item: boolean;
}

const DOCUMENT_ROUTE = /^projects(?:\/|$)/;

/** The prompt editor's own subPath under `prompts`, or null on another editor's route. */
export function promptSubPath(subPath: string): string | null {
  return subPath === "prompts" ? "" : subPath.startsWith("prompts/") ? subPath.slice(8) : null;
}

export function locate(subPath: string): Location {
  const prompts = promptSubPath(subPath);
  if (prompts !== null) return { section: "prompts", item: parsePromptSelection(prompts) !== null };
  if (DOCUMENT_ROUTE.test(subPath))
    return { section: "projects", item: parseDocumentRoute(subPath).path !== "" };
  return {
    section: "global",
    item: parseRulesRoute(subPath) !== null || parseCatalogRoute(subPath) !== null,
  };
}

export const SECTIONS: readonly { section: Section; label: string; subPath: string }[] = [
  { section: "global", label: "Global", subPath: "global" },
  { section: "projects", label: "Projects", subPath: "projects" },
  { section: "prompts", label: "Plugin prompts", subPath: "prompts" },
];

/** Display names the page has already loaded; a missing one falls back to the id. */
export interface Names {
  doc(id: string): string | undefined;
  rule(id: string): string | undefined;
  project(id: string): string | undefined;
  plugin(id: string): string | undefined;
}

/** One level of the trail. `subPath` holds raw segments; a level without one is the open item. */
export interface Crumb {
  label: string;
  subPath?: string;
}

const decode = (subPath: string) => {
  try {
    return subPath.split("/").map(decodeURIComponent);
  } catch {
    return subPath.split("/");
  }
};
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The trail for `subPath`: the editor, then each level down to the open item.
 * Every level but the last links back up, so a phone can leave an item without the sidebar.
 */
export function pageTrail(subPath: string, names: Names): Crumb[] {
  const { section, item } = locate(subPath);
  const root = SECTIONS.find((entry) => entry.section === section)!;
  const top: Crumb = { label: root.label, subPath: root.subPath };
  if (!item) return [{ label: root.label }];
  if (section === "prompts") {
    const selection = parsePromptSelection(promptSubPath(subPath)!)!;
    const plugin = names.plugin(selection.pluginId) ?? selection.pluginId;
    return [
      top,
      { label: plugin },
      { label: "tool" in selection ? selection.tool : fileName(selection.path) },
    ];
  }
  if (section === "projects") {
    const route = parseDocumentRoute(subPath);
    const parts = decode(subPath);
    const project = route.projectId === "at" ? undefined : names.project(route.projectId);
    return [
      top,
      {
        label: project ?? fileName(route.rootHint ?? route.projectId),
        subPath: parts.slice(0, parts[1] === "at" ? 4 : 3).join("/"),
      },
      { label: route.path },
    ];
  }
  const rules = parseRulesRoute(subPath);
  if (rules !== null) {
    if (rules.rule === null) return [top, { label: "Rules" }];
    return [
      top,
      { label: "Rules", subPath: RULES_ROUTE },
      { label: names.rule(rules.rule) || "Untitled rule" },
    ];
  }
  const selection = parseCatalogRoute(subPath)!;
  if ("doc" in selection) return [top, { label: names.doc(selection.doc) ?? selection.doc }];
  return selection.path === "SKILL.md"
    ? [top, { label: selection.skill }]
    : [
        top,
        { label: selection.skill, subPath: `global/skills/${selection.skill}/SKILL.md` },
        { label: selection.path },
      ];
}

/** The absolute app route of a crumb's raw `subPath`, encoding each segment as bb's router does. */
export function crumbRoute(subPath: string): string {
  return `/plugins/agent-instructions/instructions/${subPath.split("/").map(encodeURIComponent).join("/")}`;
}
