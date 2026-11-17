import type { PluginAgentConfiguration, PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { PLUGIN_INSTRUCTIONS_MAX_CHARS, type InstructionFiles } from "@bb-plugins/instructions";
import { join } from "node:path";
import type { Drive } from "./drive.ts";
import type { Captain, Registry } from "./registry.ts";
import { CAPTAIN_SKILLS, METADATA_ROLES, parseRole, ROLE_SPECS, type Role } from "./roles.ts";
import type { Store } from "./store.ts";

/** Who a thread is to Captain, decided from metadata first, then its parent. */
export type Identity =
  | { kind: "captain"; captainId: string; name: string }
  | { kind: "crew"; captain: Captain | null; role: Role | null }
  | { kind: "none" };

export type ConfigureDeps = {
  registry: Registry;
  store: Pick<Store, "crewRole">;
  drive: Drive;
  files: InstructionFiles;
};

const NONE: PluginAgentConfiguration = { tools: [], skills: [] };
/** Read no more of a Drive file than the whole budget could hold. */
const DRIVE_READ_MAX_BYTES = 4 * PLUGIN_INSTRUCTIONS_MAX_CHARS;

/**
 * Runs on every session build of every thread in bb, so the "neither" path is
 * a metadata check and one Map lookup, with no disk or database read.
 */
export function identify(
  context: PluginAgentConfigurationContext,
  deps: Pick<ConfigureDeps, "registry" | "store">,
): Identity {
  const meta = context.pluginMetadata;
  const name = captainName(meta["captain"]);
  if (name !== null) return { kind: "captain", captainId: context.thread.id, name };
  const parent = deps.registry.get(context.thread.parentThreadId);
  const metaRole = parseRole(meta["role"]);
  if (metaRole !== null && METADATA_ROLES.has(metaRole)) {
    return { kind: "crew", captain: parent, role: metaRole };
  }
  if (parent === null) return { kind: "none" };
  const role =
    deps.store.crewRole(context.thread.id)?.role ?? deps.registry.pendingRole(parent.threadId);
  return { kind: "crew", captain: parent, role };
}

/** `pluginMetadata.captain` is untrusted: accept only `{ name: <1..80 chars> }`. */
function captainName(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const name = (value as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : null;
}

export function configure(
  context: PluginAgentConfigurationContext,
  deps: ConfigureDeps,
): PluginAgentConfiguration {
  const identity = identify(context, deps);
  switch (identity.kind) {
    case "none":
      return NONE;
    case "captain":
      return captainConfiguration(identity, deps);
    case "crew":
      return crewConfiguration(identity, context.project.id, deps);
  }
}

function captainConfiguration(
  identity: Extract<Identity, { kind: "captain" }>,
  { registry, drive, files }: ConfigureDeps,
): PluginAgentConfiguration {
  const dir = registry.driveDir(identity.captainId);
  const rules = files.read("captain", {
    name: JSON.stringify(identity.name),
    drive: dir ?? "(not yet known; run `bb captain drive read CAPTAIN.md`)",
  });
  const sections: DriveSection[] = [];
  if (dir !== null) {
    const skills = drive.skillsIndex(dir);
    if (skills.length > 0) {
      sections.push({
        heading: "Drive skills",
        body: skills.map((path) => `- ${path}`).join("\n"),
      });
    }
    sections.push(driveFile(drive, dir, "CAPTAIN.md"));
  }
  return {
    tools: [],
    skills: [...CAPTAIN_SKILLS],
    instructions: budget([rules], sections, files.read("drive-truncated")),
  };
}

function crewConfiguration(
  identity: Extract<Identity, { kind: "crew" }>,
  projectId: string,
  { registry, drive, files }: ConfigureDeps,
): PluginAgentConfiguration {
  const { captain, role } = identity;
  const dir = captain === null ? null : registry.driveDir(captain.threadId);
  const rules = files.read("crew", {
    captain: JSON.stringify(captain?.name ?? "unknown"),
    drive: dir ?? "(unknown)",
  });
  const contract = role === null ? null : ROLE_SPECS[role].contract;
  const fixed = contract === null ? [rules] : [rules, files.read(contract)];
  const sections: DriveSection[] = [];
  if (captain !== null && dir !== null) {
    sections.push(driveFile(drive, dir, "CREW.md"));
    const repo = captain.repos.find((entry) => entry.bbProjectId === projectId);
    if (repo !== undefined)
      sections.push(driveFile(drive, dir, `repos/${repo.tasksProjectKey}.md`));
  }
  return {
    tools: [],
    skills: role === null ? [] : [...ROLE_SPECS[role].skills],
    instructions: budget(fixed, sections, files.read("drive-truncated")),
  };
}

export type DriveSection = { heading: string; body: string | null };

function driveFile(drive: Drive, dir: string, path: string): DriveSection {
  return { heading: path, body: drive.read(join(dir, path), DRIVE_READ_MAX_BYTES) };
}

/**
 * Join the rules, then the Drive sections, into at most `max` characters. The
 * cut lands only on Drive text: a section that does not fit is cut and ends
 * with the marker, and the sections after it are dropped. Missing or empty
 * Drive files contribute nothing.
 */
export function budget(
  fixed: readonly string[],
  sections: readonly DriveSection[],
  marker: string,
  max: number = PLUGIN_INSTRUCTIONS_MAX_CHARS,
): string {
  const head = fixed.filter((text) => text.trim() !== "").join("\n\n");
  const blocks = sections.flatMap(({ heading, body }) => {
    const text = body?.trim() ?? "";
    return text === "" ? [] : [`\n\n## ${heading}\n\n${text}`];
  });
  const full = head + blocks.join("");
  if (full.length <= max) return full;
  const tail = `\n\n${marker}`;
  // The rules come first, so a cut at `max - tail` lands on Drive text unless the rules alone overflow.
  return head.length + tail.length <= max
    ? full.slice(0, max - tail.length) + tail
    : head.slice(0, max);
}
