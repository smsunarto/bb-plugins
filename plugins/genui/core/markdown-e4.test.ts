import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, dataKey, evaluate, formatDiagnostics, initialState, parseDataFile, toMarkdown } from "./index";

function markdown(source: string, files: Record<string, string> = {}): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  const data = new Map(Object.entries(files).map(([path, text]) => [dataKey({ path, raw: false }), parseDataFile(path, text)]));
  return toMarkdown(evaluate(result.program, initialState(result.program, data), data).roots);
}

const gallery = (name: string) => readFileSync(new URL(`../gallery/data/${name}`, import.meta.url), "utf8");

describe("toMarkdown: Findings reviews", () => {
  it("leads a review with its verdict and status counts, and says where each finding stands", () => {
    const text = markdown(`Findings(Load("data/findings-review.json"))`, { "data/findings-review.json": gallery("findings-review.json") });
    expect(text.split("\n\n").slice(0, 3)).toEqual([
      "**Coil review** — 🔴 2 P1 · 🟠 3 P2",
      "🔴 **Fix required: 1 P1, 1 P2 open · 1 awaiting confirmation**",
      "1 open · 1 deferred to shared shell · 1 fixed, awaiting confirmation · 1 confirmed · 1 rejected",
    ]);
    expect(text).toContain("- P1: Pause drawer secondary text fails contrast in the dark theme (`shared shell`) — _Deferred to shared shell · round 2_");
    expect(text).toContain("- P2: Snake head overlaps the score HUD at the arena's top edge (`layout`) — _Rejected by Coil owner · round 2_");
  });

  it("says a ship verdict still has open findings", () => {
    const text = markdown(`Findings({game: "Snake", verdict: "ship", findings: [{severity: "P2", issue: "Focus ring missing", area: "focus"}]})`);
    expect(text).toBe("**Snake review** — 🟠 1 P2\n\n🟠 **Ship: 1 P2 open**\n\n- P2: Focus ring missing (`focus`)");
  });
});
