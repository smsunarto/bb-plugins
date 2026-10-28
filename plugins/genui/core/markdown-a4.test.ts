import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dataKey, type LoadedData } from "./data";
import { compile, evaluate, formatDiagnostics, initialState, toMarkdown } from "./index";
import type { Value } from "./types";

function markdown(source: string, files: Record<string, Value> = {}): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  const data = new Map<string, LoadedData>(Object.entries(files).map(([path, value]) => [dataKey({ path, raw: false }), { ok: true, value } as LoadedData]));
  return toMarkdown(evaluate(result.program, initialState(result.program, data), data).roots);
}

const fixture = (name: string): Value => JSON.parse(readFileSync(new URL(`../gallery/data/${name}`, import.meta.url), "utf8")) as Value;
const example = (name: string) => readFileSync(new URL(`../gallery/${name}`, import.meta.url), "utf8");

describe("toMarkdown: Acceptance", () => {
  it("writes one status per criterion as a list: the verdict first, what needs the user, then each check with its note and evidence", () => {
    const out = markdown(example("Acceptance-checklist.ui"));
    expect(out.split("\n\n").slice(0, 2).join("\n\n")).toBe(`**Waitlist: go live** · 12 criteria · 1 optional
**Not done**: 3 of 11 required criteria proven · 2 blocked · 4 not tested · 2 only claimed

**Needs you**
- Walk the join with VoiceOver — Manual screen-reader walk of the join
- Disable the public link or set a tester limit in App Store Connect — Public TestFlight link disabled or capped
- Send counsel docs/compliance/ and the legal memo — Counsel review of consent without double opt-in
- Stay on Free and accept queued welcomes (up to about a day), or move to a Starter tier that covers the expected peak. — Launch-week mail plan`);
    expect(out).toContain(`- ✅ Rate-limit rule on /api/waitlist — Verified by agent
  Requests 11–14 in 10 s answered 429, other paths unaffected, lifted after 10 s.
  _12 quick curls from one machine · rule 3c8d09ea · 2026-10-08_
  Evidence: [Cloudflare: rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)`);
    expect(out).toContain("- 💬 Sender domain orbit.example.com authenticated — Claimed by agent (unverified), not independently checked");
    expect(out).toContain("- ⛔ Public TestFlight link disabled or capped — Blocked, needs you: Disable the public link or set a tester limit in App Store Connect");
    expect(out).toContain("- ⛔ Anonymous tracking for campaigns _(optional)_ — Blocked");
  });

  it("writes a matrix as a table of marks, a legend of the marks used, and every gap cell with its reason", () => {
    const out = markdown(`Acceptance(Load("gate.json"))`, { "gate.json": fixture("acceptance/coil-gate.json") });
    const [head, needs, limitations, table, legend, gaps] = out.split("\n\n");
    expect(head).toBe(`**Coil redesign gate** · 10 criteria · 1 optional · 2 conditions
**Not done**: 2 of 9 required criteria proven · 2 failing · 1 blocked · 3 not tested · 1 only claimed
_17 cells (1 not applicable): 6 proven · 2 only claimed · 4 not tested · 2 blocked · 3 failing_
⚠️ Owner reports complete, but 7 required criteria are not proven`);
    expect(needs).toBe("**Needs you**\n- Restore Rook billing — Plays a live Rook match (Source server, Published site)");
    expect(limitations?.split("\n")[0]).toBe("Limitations the owner stated:");
    expect(table?.split("\n").slice(0, 6)).toEqual([
      "| Criterion | Source server | Published site |",
      "| --- | --- | --- |",
      "| ✅ Desktop layout fits the arena | ✅ | ✅ |",
      "| ⚪ Portrait controls fit | ✅ | ⚪ |",
      "| ⚪ Landscape controls fit | ✅ | ⚪ |",
      "| ❌ Paused layout in landscape | ❌ | ⚪ |",
    ]);
    expect(legend).toBe("_✅ passed · ❌ failed · ⛔ blocked · ⚪ not tested · 💬 only claimed · ➖ not applicable_");
    expect(gaps?.split("\n")[0]).toBe("**Gaps** (12 cells)");
    expect(out).toContain(`- ❌ Paused layout in landscape · Source server — Failed
  Live landscape controls fit; the defect is the paused layout: the arena is hidden while paused.
  _Chrome mobile emulation 852×393_
  Evidence: \`data/acceptance/coil/viewport-lifecycle.json:19-22\``);
    expect(out).toContain(`- ⛔ **Plays a live Rook match** (reviewer)
  Coil's live Rook test is unproven. Rook failed before it could run, on both surfaces, for the same billing reason.
- ⛔ Plays a live Rook match · Source server — Blocked, needs you: Restore Rook billing
  Rook failed before it could run: billing is blocked.
  Evidence: “Coil's live Rook test is unproven. Rook failed before it could run.”`);
  });

  it("follows the columns param and says how many columns it left out", () => {
    const out = markdown(`Acceptance(Load("b.json"), ["Mac · Whisper", "iPhone · Whisper"])`, { "b.json": fixture("acceptance/orbit-baseline.json") });
    expect(out.split("\n").slice(0, 3)).toEqual([
      "**Baseline: tier × platform × engine** · 4 criteria · 2 conditions · 4 more not shown",
      "**Not done**: 0 of 4 criteria proven · 4 blocked",
      "_8 cells: 8 blocked_",
    ]);
    expect(out).toContain("| Criterion | Mac · Whisper | iPhone · Whisper |");
    expect(out).toContain("- ⛔ Tier 1 latency baseline · Mac · Whisper — Blocked (captureBlocked)\n  The capture fixture is missing, so no latency was measured.\n  _baseline wave 1_");
  });

  it("says when there is nothing, and why input is unusable", () => {
    expect(markdown(`Acceptance([])`)).toBe("**Acceptance** · no criteria yet");
    expect(markdown(`Acceptance(42)`)).toBe("_(Acceptance needs a list of criteria [{name, status}] or [{name, cells: {column: status}}])_");
    expect(markdown(`Acceptance([{name: "Builds", status: "pass"}, {name: "Ships", status: "done"}])`)).toBe(`**Acceptance** · 2 criteria
**Not proven**: 1 of 2 criteria proven · 1 only claimed

- ✅ Builds — Passed
- 💬 Ships — Claimed (done), not independently checked`);
  });
});
