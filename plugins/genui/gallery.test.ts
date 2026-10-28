import { describe, expect, it } from "vitest";
import { collectLoads, compile, dataKey, evaluate, formatDiagnostics, initialState, probeInteractions, type LoadedData } from "./core";
import type { UiNode } from "./core/types";
import { COMPONENTS } from "./core/catalog";
import { listGallery, loadGalleryFile, readGallerySpec } from "./data-source";
import { examplesOf } from "./examples";
import { checkSpec } from "./fallback";

function errorNodes(nodes: readonly UiNode[]): string[] {
  const found: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== "object" || value === null) return;
    const node = value as Partial<UiNode>;
    if (node.kind === "node" && node.type === "Error") found.push(String(node.props?.message));
    Object.values(node.props ?? {}).forEach(visit);
  };
  nodes.forEach(visit);
  return found;
}

describe("gallery", () => {
  // The gallery page and the ui_examples tool both serve these files.
  it("has an example for every component", async () => {
    const names = await listGallery();
    const missing = Object.keys(COMPONENTS).filter((component) => examplesOf(names, component).length === 0);
    expect(missing).toEqual([]);
  });

  it("names every example after a component", async () => {
    const strays = (await listGallery()).filter((name) => !Object.hasOwn(COMPONENTS, name.replace(/\.ui$/, "").split("-")[0]));
    expect(strays).toEqual([]);
  });

  it("has examples that compile and evaluate without errors", async () => {
    for (const name of await listGallery()) {
      const compiled = compile(await readGallerySpec(name));
      expect(formatDiagnostics(compiled.diagnostics.filter((d) => d.severity === "error")), name).toBe("");
      const program = compiled.program!;
      const data = new Map<string, LoadedData>();
      // Every file an example Loads or Snippets must be in gallery/.
      for (const request of collectLoads(program)) {
        const loaded = await loadGalleryFile(request.path, request);
        expect(loaded, `${name}: ${request.path}`).toMatchObject({ ok: true });
        data.set(dataKey(request), loaded);
      }
      const state = initialState(program, data);
      const initial = evaluate(program, state, data);
      expect(initial.diagnostics.map((d) => d.message), name).toEqual([]);
      expect(errorNodes(initial.roots), name).toEqual([]);
      // The examples are what agents copy: their inputs must work at every end too.
      const { failures } = probeInteractions(program, state, initial, data);
      expect(failures.map(({ probe, diagnostics }) => `after ${probe.describe}: ${formatDiagnostics(diagnostics)}`), name).toEqual([]);
    }
  });

  // check_ui's extra checks for 3D: GLSL per pass, a Scene read again later in its animation, asset files.
  it("has Scene and Shader examples check_ui passes", async () => {
    const names = (await listGallery()).filter((name) => /^(Scene|Shader)[.-]/.test(name));
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const name of names) {
      const { ok, report } = await checkSpec(await readGallerySpec(name), (request) => loadGalleryFile(request.path, request));
      expect(ok ? "" : report, name).toBe("");
    }
  });
});
