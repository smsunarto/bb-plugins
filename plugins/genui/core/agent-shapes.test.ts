import { describe, expect, it } from "vitest";
import {
  compile,
  compileStreaming,
  evaluate,
  formatDiagnostics,
  formMessage,
  initialState,
  toMarkdown,
} from "./index";
import { toNumber } from "./evaluate";
import type { UiNode } from "./types";

// Blocks agents sent in a week of BB threads (BBP-22 audit) that failed to
// render. Each keeps its shape (arity, keys, ⭐); the words are changed.

const SELECT_KEYED = `Form("Follow-ups", [
  Select("push", "Push the fixes to main?", ["⭐ Yes, as soon as checks pass", "Show me the fixes first"]),
  Select("pins", "Repo version pins", ["⭐ Keep direct links first", "Honor repo pins"]),
  Select("sync", "The pre-existing sync bugs", ["⭐ Fix in a separate thread after this lands", "Leave them for now"])
])`;

const SELECT_LABELLED = `Form("Before I ship", [
  Select("Force speakers when recording", ["⭐ Turn on: audio stays on the loudspeaker", "Leave off"]),
  Select("Publishing", ["⭐ Push and open a PR", "Hold locally for now"])
])`;

const DECISION_TEXT = `Decision("Merge the sync PR and push which tag?", [
  {label: "⭐ Merge + tag v1.0.2", description: "Continues the current v1 line."},
  {label: "Merge + tag v0.23.0", description: "Follows the literal v0.x request."},
  {label: "Hold", description: "Review it yourself first."}
])`;

const DECISION_OBJECT = `Decision({
  question: "How should we close the remaining gap?",
  options: [
    {label: "⭐ Join webhook", description: "Catches every join within milliseconds."},
    {label: "Poll every active call", description: "Code only, two calls a second per call."},
    {label: "Accept as is", description: "Track the gap as a known limitation."}
  ]
})`;

const CARD_SOURCE = `$price = 904
$rate = 0.35
Card("Rent vs buy", [
  Row([Stepper($price, 300, 2000, 25, label: "Price ($)"), Slider($rate, 0.10, 0.80, 0.05, label: "Cloud rate ($/hr)")]),
  Metric("Break-even GPU hours", fmt(round($price / $rate, 0)))
], source: "https://example.com/gpu-pricing")`;

const BENCHMARK_SOURCE = `Card("Cold start", [Benchmark([{name: "boot", before: 820, after: 610}], "ms", source: "illustrative")])`;

const PULL_REQUESTS = `Card("Shipped", [PullRequest(["acme/client#2419", "https://github.com/acme/client/pull/2425", "acme/server#1336"])])`;

// The whole audit block (thr_e3pxmiyjgp): Number() on the inputs, and arithmetic on them.
const NUMBER = `$hc = 30
$famPct = 40
$ee = 750
$fam = 2300
$depCover = 80
eeOnly = $hc * (1 - $famPct / 100)
famN = $hc * $famPct / 100
current = (eeOnly * $ee + famN * $fam) * 12
proposed = (eeOnly * $ee + famN * ($ee + ($fam - $ee) * $depCover / 100)) * 12
Card("Annual employer cost", [
  Row([Stepper($hc, 1, 500, label: "Employees"), Slider($famPct, 0, 100, label: "% on family tier")]),
  Row([Input($ee, label: "Employee-only premium / mo"), Input($fam, label: "Family premium / mo")]),
  Slider($depCover, 50, 100, step: 5, label: "% of dependent cost covered"),
  Row([
    Metric("Today", "$" + fmt(round(current, 0)), source: "illustrative"),
    Metric("Proposed", "$" + fmt(round(proposed, 0)), source: "illustrative"),
    Metric("Savings", "$" + fmt(round(current - proposed, 0)), note: "Each family employee pays $" + fmt(round((Number($fam) - Number($ee)) * (1 - $depCover / 100), 0)) + "/mo", tone: "good", source: "illustrative")
  ])
])`;

function compiled(source: string) {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  expect(errors).toEqual([]);
  return { program: result.program, warnings: result.diagnostics.map((d) => d.message) };
}

function render(source: string, edit: Record<string, unknown> = {}) {
  const { program, warnings } = compiled(source);
  const state = { ...initialState(program), ...edit } as ReturnType<typeof initialState>;
  const { roots, diagnostics } = evaluate(program, state);
  expect(diagnostics).toEqual([]);
  return { roots, state, warnings };
}

function find(node: UiNode, type: string): UiNode[] {
  const found = node.type === type ? [node] : [];
  for (const value of Object.values(node.props as Record<string, unknown>)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (typeof child === "object" && child !== null && "type" in child && "props" in child) {
        found.push(...find(child as UiNode, type));
      }
    }
  }
  return found;
}

const answer = (roots: readonly UiNode[]) =>
  formMessage(find(roots[0]!, "Form")[0] as Parameters<typeof formMessage>[0]);

describe("Select with a label where its $state goes", () => {
  it('reads Select("key", "label", options) as a labelled Select bound to $key', () => {
    const { roots, state, warnings } = render(SELECT_KEYED);
    const selects = find(roots[0]!, "Select").map(
      (node) => (node.props as { label: unknown }).label,
    );
    expect(selects).toEqual([
      "Push the fixes to main?",
      "Repo version pins",
      "The pre-existing sync bugs",
    ]);
    expect(state).toMatchObject({ push: "", pins: "", sync: "" });
    expect(warnings).toContain(
      "`Select` got its label where its `$state` goes; bound the pick to `$push` and made the text its label: Select($value, options, label?)",
    );
  });

  it("puts each pick in the answer under its label", () => {
    const { roots } = render(SELECT_KEYED, {
      push: "Show me the fixes first",
      sync: "Leave them for now",
    });
    expect(answer(roots)).toBe(
      "Push the fixes to main? Show me the fixes first\nRepo version pins: —\nThe pre-existing sync bugs: Leave them for now",
    );
  });

  it('reads Select("label", options) as a labelled Select with its own state', () => {
    const { roots, state } = render(SELECT_LABELLED, { select2: "Hold locally for now" });
    expect(Object.keys(state)).toEqual(["select", "select2"]);
    expect(answer(roots)).toBe(
      "Force speakers when recording: —\nPublishing: Hold locally for now",
    );
  });

  it("never binds a state another rewrite declared", () => {
    const { roots, state } = render(
      `Card("x", [Form([Select("Region", ["eu", "us"]), Select("select", "Plan", ["a", "b"]), Decision("Q?", ["yes", "no"]), Select("decision", "Tier", ["c", "d"])])])`,
      { select: "us" },
    );
    expect(Object.keys(state).sort()).toEqual(["decision", "decision2", "select", "select2"]);
    expect(answer(roots)).toBe("Region: us\nPlan: —\nQ? —\nTier: —");
  });

  it("binds a declared state named by the key", () => {
    const { state } = render(`$push = "Show me the fixes first"\n${SELECT_KEYED}`);
    expect(state.push).toBe("Show me the fixes first");
  });

  it("keeps text that is one of the options as the starting value, and a label: given keeps its error", () => {
    expect(render(`Card("x", [Select("Pro", ["Basic", "Pro"])])`).state).toEqual({ select: "Pro" });
    const result = compile(`Card("x", [Select("Plan", ["Basic", "Pro"], label: "Plan")])`);
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });
});

describe("Decision written as a question", () => {
  it("renders Decision(question, [{label, description}]) as a Radio question", () => {
    const { roots, state, warnings } = render(DECISION_TEXT);
    expect(roots[0]!.type).toBe("Card");
    const [radio] = find(roots[0]!, "Radio");
    expect(radio!.props).toMatchObject({
      label: "Merge the sync PR and push which tag?",
      options: [
        { value: "⭐ Merge + tag v1.0.2", detail: "Continues the current v1 line." },
        { value: "Merge + tag v0.23.0", detail: "Follows the literal v0.x request." },
        { value: "Hold", detail: "Review it yourself first." },
      ],
    });
    expect(state).toEqual({ decision: "" });
    expect(warnings[0]).toMatch(
      /^`Decision` scores options against criteria; with none it is a question/,
    );
  });

  it("puts the pick in the answer after the question", () => {
    const { roots } = render(DECISION_TEXT, { decision: "Hold" });
    expect(answer(roots)).toBe("Merge the sync PR and push which tag? Hold");
  });

  it("renders Decision({question, options}) the same way", () => {
    const { roots } = render(DECISION_OBJECT, { decision: "Accept as is" });
    expect(find(roots[0]!, "Radio")).toHaveLength(1);
    expect(answer(roots)).toBe("How should we close the remaining gap? Accept as is");
  });

  it("is only its Radio inside a Form, so the pick is sent once", () => {
    for (const source of [
      `Card("x", [Form([Decision("Q?", ["yes", "no"]), Select("p", "Plan", ["a", "b"])])])`,
      `q = Decision("Q?", ["yes", "no"])\nCard("x", [Form([q, Select("p", "Plan", ["a", "b"])])])`,
    ]) {
      const { roots } = render(source, { decision: "yes", p: "a" });
      expect(find(roots[0]!, "Form")).toHaveLength(1);
      expect(find(roots[0]!, "Radio")).toHaveLength(1);
      expect(answer(roots)).toBe("Q? yes\nPlan: a");
    }
  });

  it("changes only the occurrence inside the Form, so the same question used outside one keeps its Card", () => {
    const source = `$advanced = false\nq = Decision("Q?", ["yes", "no"])\n$advanced ? Form([q]) : q`;
    const outside = render(source).roots[0]!;
    expect(outside.type).toBe("Card");
    expect(find(outside, "Form")).toHaveLength(1);
    expect(find(outside, "Radio")).toHaveLength(1);
    const inside = render(source, { advanced: true }).roots[0]!;
    expect(inside.type).toBe("Form");
    expect(find(inside, "Form")).toHaveLength(1);
    expect(find(inside, "Card")).toHaveLength(0);
    expect(find(inside, "Radio")).toHaveLength(1);
    // A question picked by a condition inside the Form is copied with it.
    const branch = render(
      `$a = true\nq = Decision("Q?", ["yes", "no"])\nForm([$a ? q : Text("none")])`,
      { decision: "yes" },
    ).roots;
    expect(find(branch[0]!, "Form")).toHaveLength(1);
    expect(answer(branch)).toBe("Q? yes");
  });

  it("leaves a function parameter that shares the question's name alone", () => {
    const { roots } = render(
      `q = Decision("Q?", ["yes", "no"])\nCard("x", [q, Form(["ok"].map(q => Text(q)))])`,
    );
    const form = find(roots[0]!, "Form").find((node) => find(node, "Text").length > 0)!;
    expect(find(form, "Text").map((node) => (node.props as { text: unknown }).text)).toEqual([
      "ok",
    ]);
    expect(find(form, "Radio")).toHaveLength(0);
  });

  it("compiles and renders a long chain of named values that reach a question, quickly", () => {
    const chain = Array.from({ length: 20 }, (_, i) => `a${i + 1} = $s ? a${i} : a${i}`).join("\n");
    const source = `$s = true\na0 = Decision("Q?", ["yes", "no"])\n${chain}\nForm([a20])`;
    const started = performance.now();
    const { roots } = render(source, { decision: "yes" });
    expect(performance.now() - started).toBeLessThan(100);
    expect(find(roots[0]!, "Form")).toHaveLength(1);
    expect(answer(roots)).toBe("Q? yes");
  });

  it("leaves data a Form holds as it is, nodes and nulls in the same list included", () => {
    const { roots } = render(
      `q = Decision("Q?", ["yes", "no"])\nCard("x", [q, Form([Json([Text("ok"), null])])])`,
    );
    const json = find(roots[0]!, "Json")[0]!;
    const value = (json.props as { value: unknown[] }).value;
    expect(value).toHaveLength(2);
    expect(value[1]).toBeNull();
    expect((value[0] as { type: string }).type).toBe("Text");
  });

  it("takes the Radio of a question in a table cell, keeping the rows' shape", () => {
    const { roots } = render(`Form([Table(["Q"], [[Decision("Q?", ["yes", "no"])]])])`, {
      decision: "no",
    });
    expect(find(roots[0]!, "Form")).toHaveLength(1);
    const rows = (find(roots[0]!, "Table")[0]!.props as { rows: unknown[][] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(1);
    expect((rows[0]![0] as { type: string }).type).toBe("Radio");
  });

  it("walks a node shared many times once, with or without a question below it", () => {
    const chain = (bottom: string) =>
      [
        `a0 = ${bottom}`,
        ...Array.from({ length: 24 }, (_, i) => `a${i + 1} = Row([a${i}, a${i}])`),
        "Form([a24])",
      ].join("\n");
    let started = performance.now();
    render(chain(`Text("leaf")`));
    expect(performance.now() - started).toBeLessThan(250);
    started = performance.now();
    const { program } = compiled(chain(`Decision("Q?", ["yes", "no"])`));
    const { roots } = evaluate(program, initialState(program));
    expect(performance.now() - started).toBeLessThan(250);
    // Follow one path down: the tree shares each level twice, so a full walk is 2^24 visits.
    let node: UiNode | undefined = roots[0];
    let depth = 0;
    while (node !== undefined && node.type !== "Radio") {
      node = (node.props as { children?: UiNode[] }).children?.[0];
      depth++;
    }
    expect([roots[0]!.type, node?.type, depth]).toEqual(["Form", "Radio", 25]);
  });

  it("leaves Decision(options, criteria) as the scored table", () => {
    const source = `Decision([{name: "A", scores: [4, 2]}, {name: "B", scores: [3, 5]}], ["Speed", "Cost"])`;
    const { roots, warnings } = render(source);
    expect(roots[0]!.type).toBe("Decision");
    expect(warnings).toEqual([]);
  });

  it("keeps the errors of options it can't read as answers", () => {
    const result = compile(`Decision("Which?", [{name: "A", scores: [4]}])`);
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });
});

describe("source: where it isn't shown", () => {
  it("drops source: on a Card with a warning", () => {
    const { roots, warnings } = render(CARD_SOURCE);
    expect(roots[0]!.type).toBe("Card");
    expect(warnings).toEqual([
      "`Card` shows no `source:`; dropped it. Only Metric, Table and Chart caption a source",
    ]);
  });

  it("drops source: on a Benchmark with a warning", () => {
    const { roots, warnings } = render(BENCHMARK_SOURCE);
    expect(find(roots[0]!, "Benchmark")).toHaveLength(1);
    expect(warnings).toEqual([
      "`Benchmark` shows no `source:`; dropped it. Only Metric, Table and Chart caption a source",
    ]);
  });
});

describe("the retired PullRequest", () => {
  it("shows its refs as pull request links", () => {
    const { roots, warnings } = render(PULL_REQUESTS);
    expect(toMarkdown(roots)).toContain(
      "**Pull requests**\n- [acme/client#2419](https://github.com/acme/client/pull/2419)\n- [acme/client#2425](https://github.com/acme/client/pull/2425)\n- [acme/server#1336](https://github.com/acme/server/pull/1336)",
    );
    expect(warnings).toEqual([
      "`PullRequest` was retired; its pull requests are shown as links. The Source Control card shows a pull request's status",
    ]);
  });

  it("shows one ref on one line, and text that names no pull request as it is", () => {
    expect(toMarkdown(render(`PullRequest(["acme/client#7"])`).roots)).toBe(
      "**Pull request:** [acme/client#7](https://github.com/acme/client/pull/7)",
    );
    expect(toMarkdown(render(`PullRequest(["client#7", "acme/client#8"])`).roots)).toContain(
      "- client#7\n",
    );
  });

  it("shows refs a named value holds", () => {
    expect(toMarkdown(render(`refs = ["acme/client#7"]\nPullRequest(refs)`).roots)).toBe(
      "**Pull request:** [acme/client#7](https://github.com/acme/client/pull/7)",
    );
  });
});

describe("Number()", () => {
  it("reads the number a text input holds", () => {
    const { roots } = render(NUMBER, { ee: 800, fam: 2300 });
    expect(toMarkdown(roots)).toContain("$504,000");
    expect(toMarkdown(roots)).toContain("Each family employee pays $300/mo");
  });

  it("marks an Input whose state was declared a number, so typing keeps it one", () => {
    // Text that spells no number stays text, and the arithmetic says so.
    const { program } = compiled(NUMBER);
    const { roots, diagnostics } = evaluate(program, { ...initialState(program), ee: "8a" });
    expect(diagnostics.map((d) => d.message).join("\n")).toContain("needs a number");
    const inputs = find(roots[0]!, "Input").map((node) => (node.props as { value: unknown }).value);
    expect(inputs).toEqual([
      { kind: "binding", name: "ee", value: "8a", number: true },
      { kind: "binding", name: "fam", value: "2300", number: true },
    ]);
    const text = render(`$name = "x"\nInput($name)`).roots[0]!;
    expect((text.props as { value: unknown }).value).toEqual({
      kind: "binding",
      name: "name",
      value: "x",
    });
  });

  it("reads long text that spells no number in linear time", () => {
    // An Input's text has no length limit; a backtracking pattern took 2.5 s here.
    const started = performance.now();
    expect(toNumber(`${"1".repeat(50_000)}x`)).toBeNull();
    expect(toNumber(`${"1".repeat(50_000)}.5x`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("is null for text that spells no number", () => {
    const { roots } = render(
      `Text("n: " + (Number("abc") ?? "none") + ", " + (Number("") ?? "none") + ", " + Number(" -1.5e2 "))`,
    );
    expect(toMarkdown(roots)).toBe("n: none, none, -150");
  });
});

describe("while streaming", () => {
  it("compiles every prefix of each shape without throwing", () => {
    for (const source of [
      SELECT_KEYED,
      SELECT_LABELLED,
      DECISION_TEXT,
      DECISION_OBJECT,
      CARD_SOURCE,
      PULL_REQUESTS,
    ]) {
      for (let end = 1; end <= source.length; end++)
        expect(() => compileStreaming(source.slice(0, end))).not.toThrow();
    }
  });
});
