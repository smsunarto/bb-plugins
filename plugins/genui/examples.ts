// Local fork: authored agent text is loaded from instructions/ for Agent Instructions → Plugin prompts.
import { instructionFiles } from "@bb-plugins/instructions";
// Worked examples for the ui_examples tool, taken from the gallery specs
// (gallery/<Component>.ui and gallery/<Component>-<variant>.ui). They are the
// specs the gallery page renders, so an example the tool returns is known to
// compile and draw. "app" returns the ```app guide instead, with the example
// pages in gallery/app/ (appLint.test.ts keeps them lint-clean).
import { readFile } from "node:fs/promises";
import { collectLoads, compile } from "./core";
import { COMPONENTS, componentSignature, type ComponentName } from "./core/catalog";
import { listGallery, loadGalleryFile, packagePath, readGallerySpec } from "./data-source";

const instructionText = instructionFiles(import.meta.url);

/**
 * What a ```app page can rely on (the bootstrap in ui/appDocument.ts runs before
 * it) and what makes one work for the reader, adapted from OpenGenerativeUI's
 * advanced-visualization, master-playbook and svg-diagrams skills.
 */
const APP_GUIDE = instructionText.read("app-guide");

/** The example pages in gallery/app/, each with what it shows. */
const APP_EXAMPLES = [
  {
    file: "cache.html",
    shows:
      "an SVG diagram driven by validated inputs, with units, an assumption, a Reset and a tone that follows the result",
  },
  {
    file: "catch.html",
    shows:
      "a canvas game: one loop with Pause, sized to its container and devicePixelRatio, theme colours, the best score kept in localStorage, genui.answer in a click",
  },
];

async function appGuide(): Promise<string> {
  const examples = await Promise.all(
    APP_EXAMPLES.map(async ({ file, shows }) => {
      const source = (await readFile(packagePath("gallery", "app", file), "utf8")).trimEnd();
      return `Example, ${shows}:\n\`\`\`app\n${source}\n\`\`\``;
    }),
  );
  return [APP_GUIDE, ...examples].join("\n");
}

/** Per example, how much of each file it Loads is shown. */
const DATA_PREVIEW_CHARS = 600;

/**
 * For components that read a tool's output: the commands that save it where
 * Load reads it. Gallery examples Load gallery files (`data/…`); in a thread
 * the file goes to $BB_THREAD_STORAGE.
 */
const SOURCES: Partial<Record<ComponentName, string>> = {
  Tests: instructionText.read("sources/tests"),
  Json: instructionText.read("sources/json"),
  Logs: instructionText.read("sources/logs"),
  StackTrace: instructionText.read("sources/stacktrace"),
  Findings: instructionText.read("sources/findings"),
  Coverage: instructionText.read("sources/coverage"),
  Dependencies: instructionText.read("sources/dependencies"),
  Pipeline: instructionText.read("sources/pipeline"),
  Benchmark: instructionText.read("sources/benchmark"),
  Waterfall: instructionText.read("sources/waterfall"),
  Treemap: instructionText.read("sources/treemap"),
  Board: instructionText.read("sources/board"),
  Acceptance: instructionText.read("sources/acceptance"),
  Transcript: instructionText.read("sources/transcript"),
  Provenance: instructionText.read("sources/provenance"),
};

/**
 * For components whose API is too big for the instructions: the whole of it,
 * adapted from Zeron's show_visual reference (crates/mcp/src/tools.rs), whose
 * ui.scene and ui.shader these match.
 */
const NOTES: Partial<Record<ComponentName, string>> = {
  Scene: instructionText.read("components/scene"),
  Shader: instructionText.read("components/shader"),
};

export function isComponentName(name: string): name is ComponentName {
  return Object.hasOwn(COMPONENTS, name);
}

/** Gallery specs that show `component`, the plain one first. */
export function examplesOf(names: readonly string[], component: string): string[] {
  return names
    .filter((name) => name === `${component}.ui` || name.startsWith(`${component}-`))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

async function describe(name: string): Promise<string> {
  const source = (await readGallerySpec(name)).trimEnd();
  const parts = [`\`\`\`ui\n${source}\n\`\`\``];
  const program = compile(source).program;
  for (const request of program === null ? [] : collectLoads(program)) {
    const loaded = await loadGalleryFile(request.path, { raw: true });
    if (!loaded.ok || typeof loaded.value !== "string") continue;
    const text = loaded.value.trim();
    const shown = text.length > DATA_PREVIEW_CHARS ? `${text.slice(0, DATA_PREVIEW_CHARS)}…` : text;
    parts.push(`"${request.path}" in this example holds:\n${shown}`);
  }
  return parts.join("\n");
}

/** The tool's text: each requested component's signature and its examples, or the app guide for "app". */
export async function examplesReport(
  components: readonly string[],
): Promise<{ ok: boolean; text: string }> {
  const names = await listGallery();
  const sections: string[] = [];
  let ok = true;
  for (const component of components) {
    if (component.toLowerCase() === "app") {
      sections.push(await appGuide());
      continue;
    }
    if (!isComponentName(component)) {
      ok = false;
      sections.push(`${component}: not a component.`);
      continue;
    }
    const examples = examplesOf(names, component).slice(0, 3);
    const described = await Promise.all(examples.map(describe));
    const source = SOURCES[component];
    sections.push(
      [
        `## ${componentSignature(component)}`,
        ...(source === undefined ? [] : [`Save the data with: ${source}`]),
        ...(NOTES[component] === undefined ? [] : [NOTES[component]]),
        ...(described.length > 0 ? described : ["No example yet."]),
      ].join("\n"),
    );
  }
  return { ok, text: sections.join("\n\n") };
}
