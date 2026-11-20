import type { InstructionFiles } from "@bb-plugins/instructions";
import { createHash } from "node:crypto";
import { unifiedDiff } from "./diff.ts";
import { CAPTAIN_SKILLS, parseRole, ROLE_SPECS, type Role } from "./roles.ts";
import type { Served, Store } from "./store.ts";

/**
 * A live provider session keeps the instructions it was built with, so an edit
 * to Captain's instruction files never reaches a running Captain or crew
 * thread. `configure` records the fixed plugin part it served each thread,
 * once, with the inputs that rendered it; the background check re-renders
 * those inputs against today's files and sends the thread the difference.
 * Drive files are not part of it: they reach threads their own way.
 */

/** Everything the fixed part depends on besides the files themselves. */
export type InstructionSpec =
  | { kind: "captain"; name: string; drive: string | null }
  | { kind: "crew"; captain: string; drive: string | null; role: Role | null };

/** The plugin-owned part of a thread's instructions: rule text, then skills. */
export function renderFixed(
  files: InstructionFiles,
  spec: InstructionSpec,
): { fixed: string[]; skills: string[] } {
  if (spec.kind === "captain") {
    return {
      fixed: [
        files.read("captain", {
          name: JSON.stringify(spec.name),
          drive: spec.drive ?? "(not yet known; run `bb captain drive read CAPTAIN.md`)",
        }),
      ],
      skills: [...CAPTAIN_SKILLS],
    };
  }
  const rules = files.read("crew", {
    captain: JSON.stringify(spec.captain),
    drive: spec.drive ?? "(unknown)",
    report: files.read("report"),
  });
  const contract = spec.role === null ? null : ROLE_SPECS[spec.role].contract;
  return {
    fixed: contract === null ? [rules] : [rules, files.read(contract)],
    skills: spec.role === null ? [] : [...ROLE_SPECS[spec.role].skills],
  };
}

/** The text a fingerprint covers: the rules, then one line listing the skills. */
export function servedText(rendered: { fixed: readonly string[]; skills: readonly string[] }) {
  const skills = rendered.skills.length === 0 ? "(none)" : rendered.skills.join(", ");
  return `${rendered.fixed.filter((text) => text.trim() !== "").join("\n\n")}\n\nSkills: ${skills}`;
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Record what `configure` served a thread. Only the first record per thread
 * sticks: `configure` also runs on every later turn, and those turns keep the
 * session's first instructions. A failure is logged, never thrown, so it
 * cannot cost the thread its instructions.
 */
export function recordServed(
  deps: { store: Pick<Store, "recordServed">; now: () => number; warn: (line: string) => void },
  threadId: string,
  captainId: string,
  spec: InstructionSpec,
  rendered: { fixed: readonly string[]; skills: readonly string[] },
): void {
  try {
    const text = servedText(rendered);
    deps.store.recordServed({
      threadId,
      captainId,
      spec: JSON.stringify(spec),
      text,
      fingerprint: fingerprint(text),
      servedAt: deps.now(),
    });
  } catch (error) {
    deps.warn(`served instructions not recorded for ${threadId}: ${(error as Error).message}`);
  }
}

/** A stored spec, or null when it no longer parses (a role since removed, a corrupt row). */
export function parseSpec(json: string): InstructionSpec | null {
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    const drive = typeof value["drive"] === "string" ? value["drive"] : null;
    if (value["kind"] === "captain" && typeof value["name"] === "string") {
      return { kind: "captain", name: value["name"], drive };
    }
    if (value["kind"] === "crew" && typeof value["captain"] === "string") {
      const role = value["role"] === null ? null : parseRole(value["role"]);
      if (role === null && value["role"] !== null) return null;
      return { kind: "crew", captain: value["captain"], drive, role };
    }
    return null;
  } catch {
    return null;
  }
}

/** One thread's pending change: the text to send, and the record to move to once sent. */
export type InstructionChange = {
  threadId: string;
  from: { text: string; fingerprint: string };
  to: { text: string; fingerprint: string };
  /** What the change shows: a unified diff, or the whole new text when that is shorter. */
  form: "diff" | "full";
  change: string;
};

/** The change each served thread has not been told about; unchanged threads are left out. */
export function pendingChanges(
  files: InstructionFiles,
  served: readonly Served[],
): InstructionChange[] {
  return served.flatMap((row) => {
    const spec = parseSpec(row.spec);
    if (spec === null) return [];
    const text = servedText(renderFixed(files, spec));
    const next = fingerprint(text);
    if (next === row.fingerprint) return [];
    const diff = unifiedDiff(row.text, text);
    // Four backticks, so a fence inside the instruction text cannot close this one.
    const [form, change] =
      diff.length <= text.length
        ? (["diff", `\`\`\`\`diff\n${diff}\n\`\`\`\``] as const)
        : (["full", text] as const);
    return [
      {
        threadId: row.threadId,
        from: { text: row.text, fingerprint: row.fingerprint },
        to: { text, fingerprint: next },
        form,
        change,
      },
    ];
  });
}
