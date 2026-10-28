import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, evaluate, formatDiagnostics, initialState, toMarkdown } from "./index";

function markdown(source: string): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  return toMarkdown(evaluate(result.program, initialState(result.program)).roots);
}

const gallery = (name: string) => readFileSync(new URL(`../gallery/${name}`, import.meta.url), "utf8");

describe("toMarkdown: Compare", () => {
  it("lists the reference and what it is compared with, their facts, and that the pixel views need BB", () => {
    expect(markdown(gallery("Compare.ui"))).toBe(`**Image comparison** · Approved render vs This build

1. **Approved render** (reference) — \`data/compare/status-before.png\` — viewport 760 px · theme light · scale 1x · captured 2026-10-10 — Status gallery example as BB renders it
2. **This build** — \`data/compare/status-after.png\` — viewport 760 px · theme light · scale 1x · captured 2026-10-10 — The same panel after one edit

_Side by side, wipe, overlay and the pixel difference with its changed regions show in BB._`);
  });

  it("warns when the conditions differ, per compared image when there are several", () => {
    const two = markdown(gallery("Compare-conditions.ui"));
    expect(two).toContain("⚠️ Not the same conditions: theme light vs dark · scale 1x vs 2x · device stated only for Dark, 2x (Retina display)");
    const three = markdown(`Compare([
      {src: "a.png", meta: {theme: "light"}},
      {src: "b.png", label: "Phone", meta: {theme: "dark"}},
      {src: "c.png", label: "Desktop", meta: {theme: "light"}}
    ])`);
    expect(three).toContain("**Image comparison** · Reference vs Phone, Desktop");
    expect(three).toContain("⚠️ Phone: Not the same conditions: theme light vs dark");
    expect(three).not.toContain("Desktop: Not");
  });

  it("shows https images inline, escapes labels, and is honest about partial input", () => {
    const out = markdown(`Compare(["https://example.com/pen ref.png", {src: "shots/live_1.png", label: "Live *page*"}, {label: "no src"}])`);
    expect(out).toContain("1. **Reference** (reference) — ![Reference](https://example.com/pen%20ref.png)");
    expect(out).toContain("2. **Live \\*page\\*** — `shots/live_1.png`");
    expect(out).toContain("_1 entry without a src left out_");
    expect(markdown(`Compare(["only.png"])`)).toBe("**Image comparison** · only the reference so far\n\n1. **Reference** (reference) — `only.png`");
    expect(markdown(`Compare([])`)).toBe("**Image comparison** · no images");
  });
});
