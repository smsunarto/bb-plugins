import { describe, expect, it } from "vitest";
import { compile, evaluate, formatDiagnostics, initialState, toMarkdown } from "./index";

function markdown(source: string): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  return toMarkdown(evaluate(result.program, initialState(result.program)).roots);
}

describe("toMarkdown: references", () => {
  it("renders an Entity as name, kind, note, facts and its link; https images show, file images don't", () => {
    expect(
      markdown(`Entity("Halo 800", kind: "product", image: "https://cdn.example.com/halo (1).png", facts: {Price: "$39", Output: "800 lm"}, url: "https://www.example.com/halo", note: "Bright *enough*")`),
    ).toBe(`![Halo 800](https://cdn.example.com/halo%20%281%29.png)

**Halo 800** · Product

Bright *enough*

**Price:** $39  
**Output:** 800 lm

🔗 [example.com](https://www.example.com/halo)`);
    expect(markdown(`Entity("Ana", kind: "other", image: "images/ana.png", url: "javascript:alert(1)")`)).toBe("**Ana**");
  });

  it("numbers Sources as written, refusing non-https links in place", () => {
    expect(
      markdown(`Sources([
  {url: "https://en.wikipedia.org/wiki/Bicycle_lighting", title: "Bicycle [lighting]", note: "Overview"},
  "http://plain.example.com",
  "https://www.example.com/a_(b)"
])`),
    ).toBe(`Sources:
1. [Bicycle \\[lighting\\]](https://en.wikipedia.org/wiki/Bicycle_lighting) — en.wikipedia.org · Overview
2. http://plain.example.com _(not an https link)_
3. [example.com](https://www.example.com/a_%28b%29)`);
    expect(markdown(`Sources([])`)).toBe("");
  });

  it("lists Hotspots under the image, keeping multi-line text inside its item", () => {
    expect(
      markdown(`Hotspots("images/bike.svg", [{x: 40, y: 30, title: "Saddle", text: "Set the height.\\n\\n- knee bent"}, {x: 70, y: 20}])`),
    ).toBe(`🖼 images/bike.svg

1. **Saddle** — Set the height.

   - knee bent
2. **Point 2**`);
    expect(markdown(`Hotspots("https://example.com/bike.png", [{x: 1, y: 2, title: "Bell"}])`)).toBe(
      "![](https://example.com/bike.png)\n\n1. **Bell**",
    );
  });
});
