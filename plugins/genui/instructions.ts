// Local fork: authored agent text is loaded from instructions/ for Agent Instructions → Plugin prompts.
import { instructionFiles, TOOL_INSTRUCTIONS_MAX_CHARS } from "@bb-plugins/instructions";
// What agents are told about ```ui blocks, in the three sections BB adds to
// sessions whose replies a person reads (see server.ts). BB appends tool
// sections before plugin sections, so:
// - UI_REFERENCE (the check_ui tool's instructions) and UI_REFERENCE_MORE
//   (the ui_examples tool's) come first: the syntax and every component
//   signature, generated from the catalog so the prompt cannot drift from
//   what the parser accepts, plus the icon names.
// - AGENT_INSTRUCTIONS (bb.agents.configure) comes last, closest to the
//   conversation: when to write UI, and worked examples. Examples here are the
//   strongest lever on what models write; moved to the earlier section, the
//   same calculator example stopped being followed.
// BB refuses a tool whose instructions pass 4096 characters and truncates the
// configure section there; instructions.test.ts holds all three.
import {
  ACTIONS,
  callSignature,
  COMPONENTS,
  componentSignature,
  type ComponentGroup,
  type ComponentName,
  type ComponentSpec,
} from "./core/catalog";

const instructionText = instructionFiles(import.meta.url);

/**
 * Groups too big for the reference: their required params only, with the
 * full API in the ui_examples notes (examples.ts NOTES), which the line says
 * to read first.
 */
const BRIEF_GROUPS: Partial<Record<ComponentGroup, string>> = {
  "3D": "3D (ui_examples first: full API)",
};

/** One line per group: `Group: Sig: summary · Sig · …`. */
function componentLines(groups: readonly ComponentGroup[]): string {
  const lines = new Map<ComponentGroup, string[]>(groups.map((group) => [group, []]));
  for (const name of Object.keys(COMPONENTS) as ComponentName[]) {
    const spec: ComponentSpec = COMPONENTS[name];
    const brief = `${name}(${spec.params
      .filter((param) => !param.optional)
      .map((param) => param.name)
      .join(", ")}, …): ${spec.summary}`;
    lines
      .get(COMPONENTS[name].group)
      ?.push(
        Object.hasOwn(BRIEF_GROUPS, COMPONENTS[name].group) ? brief : componentSignature(name),
      );
  }
  return [...lines]
    .map(([group, entries]) => `${BRIEF_GROUPS[group] ?? group}: ${entries.join(" · ")}`)
    .join("\n");
}

const actionList = Object.entries(ACTIONS)
  .map(([name, spec]) => callSignature(name, spec))
  .join(" ");

/** Groups in the first reference section; the rest are in UI_REFERENCE_MORE. */
export const REFERENCE_GROUPS: readonly ComponentGroup[] = ["Layout", "Content", "Data", "Project"];
export const REFERENCE_MORE_GROUPS: readonly ComponentGroup[] = [
  "Inputs",
  "Widgets",
  "Media",
  "Dev",
  "Manage",
  "3D",
];

export const UI_REFERENCE = instructionText.read("tools/check_ui.instructions", {
  components: componentLines(REFERENCE_GROUPS),
  actions: actionList,
});

export const UI_REFERENCE_MORE = instructionText.read("tools/ui_examples.instructions", {
  components: componentLines(REFERENCE_MORE_GROUPS),
});

const MAP_EXAMPLE = instructionText.read("examples/map");

/**
 * Engineering and management work, contributed as its own section
 * (bb.agents.contributeInstructions), which BB places after the tool sections
 * and right before AGENT_INSTRUCTIONS. Says, per kind of tool output, which
 * command saves it and which component reads it, so results are shown from
 * the file instead of pasted. It no longer calls prose "the worse answer":
 * with that line, replies after a task shrank to one sentence plus UI.
 */
export const CODE_WORK_INSTRUCTIONS = instructionText.read("code-work", {
  components: componentLines(["Evidence"]),
});

/**
 * When to write UI, where, and how questions work, tuned on a 64-prompt
 * component-fit battery run headless through omp the way BB injects these
 * sections, on Haiku 5.5 and Sonnet 5.5, then in real BB. What moved models:
 * - The opening says what the user wants shown (things better seen or used
 *   than read) and that markdown tables, numbered steps, pasted code and
 *   ASCII diagrams are the wrong form for it. Without that line, markdown
 *   tables came back in a fifth of Haiku's replies.
 * - The prose-only exemption is about the reply's content (a few sentences
 *   with nothing to see), not the question: worded as "short or conceptual
 *   questions", Haiku filed recommendations, calculations and histories under
 *   it and answered half the prompts that call for UI in prose. "In doubt,
 *   add the block" settles the rest.
 * - "Read in BB, not a terminal" answers Claude Code's own system prompt,
 *   which says replies are shown as markdown in a terminal.
 * - The shape list names a component for every kind of content; components
 *   named or shown here are the ones agents reach for.
 * The old text's "the UI carries the rest, so never restate it" made replies
 * one sentence over a card; the prose rule replaces it.
 */
export const AGENT_INSTRUCTIONS = instructionText.read("inline-ui", { mapExample: MAP_EXAMPLE });

/** While the webLookups setting is off, the Map example gives way to this line. */
export const WEB_LOOKUPS_OFF = instructionText.read("web-lookups-off");

export const AGENT_INSTRUCTIONS_WEB_OFF = AGENT_INSTRUCTIONS.replace(MAP_EXAMPLE, WEB_LOOKUPS_OFF);

/** Agent Instructions → Plugin prompts validates raw files; generated signatures must fit after expansion too. */
export function assertInstructionLimit(name: string, text: string): void {
  if (text.length > TOOL_INSTRUCTIONS_MAX_CHARS) {
    throw new Error(
      `instructions/${name}.md renders ${text.length} characters; BB allows ${TOOL_INSTRUCTIONS_MAX_CHARS}`,
    );
  }
}

for (const [name, text] of [
  ["tools/check_ui.instructions", UI_REFERENCE],
  ["tools/ui_examples.instructions", UI_REFERENCE_MORE],
  ["code-work", CODE_WORK_INSTRUCTIONS],
  ["inline-ui", AGENT_INSTRUCTIONS],
  ["inline-ui", AGENT_INSTRUCTIONS_WEB_OFF],
] as const) {
  assertInstructionLimit(name, text);
}
