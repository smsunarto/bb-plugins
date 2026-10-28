import { describe, expect, it } from "vitest";
import { compileStreaming, evaluate, initialState } from "./index";
import type { UiNode, Value } from "./types";

/** The example from the agent instructions. */
const EXAMPLE = `$seats = 10
$plan = "Pro"
price = $plan == "Pro" ? 29 : 12
Card("Monthly estimate", [
  Row([Choice($plan, ["Basic", "Pro"]), Slider($seats, 1, 50, label: "Seats")]),
  Row([Metric("Per seat", "$" + price), Metric("Total", "$" + fmt(price * $seats), tone: "good")]),
  Button("Go with " + $plan, Send("Let's go with " + $plan + " for " + $seats + " seats"))
])`;

function render(source: string): UiNode[] | null {
  const { program } = compileStreaming(source);
  return program === null ? null : evaluate(program, initialState(program)).roots;
}

/** Every node in a rendered tree, including nodes nested in props. */
function countNodes(value: Value): number {
  if (Array.isArray(value)) return value.reduce((total: number, item: Value) => total + countNodes(item), 0);
  if (typeof value !== "object" || value === null || (value as UiNode).kind !== "node") return 0;
  const props: Value[] = Object.values((value as UiNode).props);
  return 1 + props.reduce((total: number, prop) => total + countNodes(prop), 0);
}

describe("compileStreaming", () => {
  it("renders the instructions example as it streams, never losing nodes once the first Row closes", () => {
    const cardLine = EXAMPLE.indexOf("[", EXAMPLE.indexOf("Card(")) + 1;
    const firstRowClosed = EXAMPLE.indexOf("]),") + 2;
    let previous = 0;
    for (let end = 0; end <= EXAMPLE.length; end++) {
      const prefix = EXAMPLE.slice(0, end);
      const roots = render(prefix);
      if (end >= cardLine) expect(roots?.[0]?.type, prefix).toBe("Card");
      if (end >= firstRowClosed) {
        const count = countNodes(roots ?? []);
        expect(count, prefix).toBeGreaterThanOrEqual(previous);
        previous = count;
      }
    }
    const result = compileStreaming(EXAMPLE);
    expect(result.complete).toBe(true);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(countNodes(render(EXAMPLE) ?? [])).toBe(previous);
  });

  it("drops a half-written element after the last comma", () => {
    const [row] = render(`Row([Metric("A", "1"), Met`) ?? [];
    expect(row.type).toBe("Row");
    expect((row.props.children as UiNode[]).map((node) => [node.type, node.props.label])).toEqual([["Metric", "A"]]);
  });

  it("closes an opening bracket as an empty list", () => {
    const result = compileStreaming(`Card("T", [`);
    expect(result.complete).toBe(false);
    const [card] = render(`Card("T", [`) ?? [];
    expect(card.props).toEqual({ title: "T", children: [] });
  });

  it("never renders a template or a reference string cut mid-way", () => {
    for (const [source, shown] of [
      ["Card(\"T\", [Text(`hello ${1 + ", []],
      ["Card(\"T\", [Text(`hello ${[1, 2].join(\", \")} wor", []],
      [`Card("T", [Text("a"), // a comment with [ and (`, [{ text: "a" }]],
      [`Card("T", [Image("shots/hom`, []],
      [`Card("T", [Map([{name: "Belém To`, [{ places: [{}] }]],
      [`Card("T", [List([{title: "a", icon: "Pl`, [{ items: [{ title: "a" }] }]],
      [`Card("T", [Callout("b", tone: "wa`, [{ text: "b" }]],
      [`Card("T", [Text("a"), Text("line one\nline two`, [{ text: "a" }]],
    ] as const) {
      const [card] = render(source) ?? [];
      expect(card.type, source).toBe("Card");
      expect((card.props.children as UiNode[]).map((node) => node.props), source).toEqual(shown);
    }
  });

  it("grows prose as it streams, closing the string and any open ** or code span", () => {
    const text = (source: string) => ((render(source)?.[0].props.children as UiNode[])[0]?.props as Record<string, Value>);
    expect(text(`Card("T", [Text("hello wor`).text).toBe("hello wor");
    expect(text(`Card("T", [Text('it\\'s a [b`).text).toBe("it's a [b");
    expect(text(`Card("T", [Text("ends in \\`).text).toBe("ends in ");
    expect(text(`Card("T", [Text("the **retry lo`).text).toBe("the **retry lo**");
    expect(text(`Card("T", [Text("the **retry loop*`).text).toBe("the **retry loop**");
    expect(text(`Card("T", [Text("call \`requ`).text).toBe("call `requ`");
    expect(text(`Card("T", [Text("the **`).text).toBe("the **");
    expect(text(`Card("T", [Steps([{title: "Rate limit", detail: "5 tries a mi`).items).toEqual([{ title: "Rate limit", detail: "5 tries a mi" }]);
  });

  it("does not count brackets inside strings", () => {
    const [a, c, row] = render(`Text("a [b")\nText("c (d {e")\nRow([Text("x"), Te`) ?? [];
    expect([a.props.text, c.props.text]).toEqual(["a [b", "c (d {e"]);
    expect(row.type).toBe("Row");
    expect((row.props.children as UiNode[]).map((node) => node.props.text)).toEqual(["x"]);
    expect(render("Text(`a ${\"]\"} [`)\nTe")?.map((node) => node.props.text)).toEqual(["a ] ["]);
  });

  it("returns no program while nothing renders yet", () => {
    for (const source of ["", "$x = 1", "$x = 1\n", "$x = 1\nCard("]) {
      const result = compileStreaming(source);
      expect(result.program, source).toBeNull();
      expect(result.complete).toBe(false);
    }
  });

  it("reports a finished spec's errors alongside the best prefix", () => {
    const result = compileStreaming(`Card("T", [Text("a"), Nope("b")])`);
    expect(result.complete).toBe(false);
    expect(result.diagnostics.some((d) => d.severity === "error" && d.message.includes("Nope"))).toBe(true);
    const roots = evaluate(result.program!, {}).roots;
    expect((roots[0].props.children as UiNode[]).map((node) => node.props.text)).toEqual(["a"]);
  });

  it("compiles 50 truncations of a 3 KB spec quickly", () => {
    const rows = Array.from(
      { length: 36 },
      (_, i) => `  Row([Metric("Label ${i}", "$" + fmt($n * ${i})), Slider($n, 0, ${i + 10}, label: "N ${i}")]),`,
    );
    const source = `$n = 3\nCard("Many rows", [\n${rows.join("\n")}\n  Text("done")\n])`;
    expect(source.length).toBeGreaterThan(3000);
    // The fastest of five passes: other test files run in parallel workers,
    // and a busy CPU must not fail a check on the compiler's own cost.
    const passes = Array.from({ length: 5 }, () => {
      const started = performance.now();
      for (let k = 1; k <= 50; k++) compileStreaming(source.slice(0, Math.floor((source.length * k) / 50)));
      return performance.now() - started;
    });
    expect(Math.min(...passes)).toBeLessThan(100);
  });
});
