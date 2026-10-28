import { describe, expect, it } from "vitest";
import { compile, evaluate, formatDiagnostics, initialState, type Program } from "./index";
import type { Action, Binding, UiNode, UiState } from "./types";

const EXAMPLE = `$seats = 10
$plan = "Pro"
price = $plan == "Pro" ? 29 : 12
Card("Monthly estimate", [
  Row([Choice($plan, ["Basic", "Pro"]), Slider($seats, 1, 50, label: "Seats")]),
  Row([Metric("Per seat", "$" + price), Metric("Total", "$" + fmt(price * $seats), tone: "good")]),
  Button("Go with " + $plan, Send("Let's go with " + $plan + " for " + $seats + " seats"))
])`;

function program(source: string): Program {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  return result.program;
}

function render(source: string, state?: UiState): { roots: UiNode[]; messages: string[] } {
  const compiled = program(source);
  const { roots, diagnostics } = evaluate(compiled, state ?? initialState(compiled));
  return { roots, messages: diagnostics.map((d) => d.message) };
}

function children(node: UiNode): UiNode[] {
  return node.props.children as UiNode[];
}

function errors(source: string): string[] {
  const result = compile(source);
  expect(result.program).toBeNull();
  return result.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
}

describe("instructions example", () => {
  it("renders the card with bindings, metrics and a stateful Send", () => {
    const compiled = program(EXAMPLE);
    const state = initialState(compiled);
    expect(state).toEqual({ seats: 10, plan: "Pro" });

    const { roots, diagnostics } = evaluate(compiled, state);
    expect(diagnostics).toEqual([]);
    expect(roots).toHaveLength(1);
    const [card] = roots;
    expect(card.type).toBe("Card");
    expect(card.props.title).toBe("Monthly estimate");

    const [inputs, metrics, button] = children(card);
    const [choice, slider] = children(inputs);
    expect(choice.type).toBe("Choice");
    expect(choice.props.value).toEqual({ kind: "binding", name: "plan", value: "Pro" } satisfies Binding);
    expect(choice.props.options).toEqual(["Basic", "Pro"]);
    expect(slider.props).toEqual({
      value: { kind: "binding", name: "seats", value: 10 },
      min: 1,
      max: 50,
      label: "Seats",
    });

    const [perSeat, total] = children(metrics);
    expect(perSeat.props).toEqual({ label: "Per seat", value: "$29" });
    expect(total.props).toEqual({ label: "Total", value: "$290", tone: "good" });

    expect(button.type).toBe("Button");
    expect(button.props.label).toBe("Go with Pro");
    expect(button.props.action).toEqual([
      { kind: "action", type: "send", text: "Let's go with Pro for 10 seats" },
    ] satisfies Action[]);
  });

  it("re-derives values when state changes, keeping keys stable", () => {
    const compiled = program(EXAMPLE);
    const before = evaluate(compiled, initialState(compiled)).roots[0];
    const after = evaluate(compiled, { seats: 1200, plan: "Basic" }).roots[0];
    const [, metrics, button] = children(after);
    expect(children(metrics).map((m) => m.props.value)).toEqual(["$12", "$14,400"]);
    expect(button.props.action).toEqual([
      { kind: "action", type: "send", text: "Let's go with Basic for 1200 seats" },
    ]);
    expect(after.key).toBe(before.key);
    expect(children(after).map((n) => n.key)).toEqual(children(before).map((n) => n.key));
  });
});

describe("expressions", () => {
  it("maps and filters lists, keying nodes by position and iteration", () => {
    const { roots } = render(`items = [{name: "a", n: 3}, {name: "b", n: 0}, {name: "c", n: 5}]
Stack(items.filter(i => i.n > 0).map((i, k) => Badge(\`\${k + 1}. \${i.name}\`)))`);
    const badges = children(roots[0]);
    expect(badges.map((b) => b.props.text)).toEqual(["1. a", "2. c"]);
    expect(badges.map((b) => b.key)).toEqual(["2:48#0", "2:48#1"]);
  });

  it("nests map keys", () => {
    const { roots } = render(`Stack([[1, 2], [3]].map(row => Row(row.map(x => Badge(x)))))`);
    const keys = children(roots[0]).flatMap((row) => [row.key, ...children(row).map((b) => b.key)]);
    expect(keys).toEqual(["1:32#0", "1:49#0#0", "1:49#0#1", "1:32#1", "1:49#1#0"]);
  });

  it("evaluates templates, functions, methods and JS-like operators", () => {
    const { roots, messages } = render(`$n = 1234.5
data = {count: 3}
Stack([
  \`\${fmt($n)} / \${fmt($n, 0)} / \${round(2.345, 2)} / \${fmt(-1234567.891)}\`,
  sum([1, 2, null, 3]) + max(4, 9, 2) + min([7, 5]) + abs(-1),
  data.count * 2 + (data.missing ?? 10),
  "a,b".split(",").join("+").toUpperCase(),
  null + "x" + true,
  (1 / 0 ?? "inf") + "",
  [1, 2, 3].find(x => x > 1) + [1, 2].indexOf(2),
  "Hello".length > 3 && !false ? "long" : "short",
  3.14159.toFixed(2)
])`);
    expect(messages).toEqual([]);
    expect(children(roots[0]).map((t) => t.props.text)).toEqual([
      "1,234.5 / 1,235 / 2.35 / -1,234,567.89",
      "21",
      "16",
      "A+B",
      "xtrue",
      "inf",
      "3",
      "long",
      "3.14",
    ]);
  });

  it("maps named args and omits absent or null optional params", () => {
    const { roots } = render(`Metric(value: "5", label: "Score", tone: null)`);
    expect(roots[0].props).toEqual({ label: "Score", value: "5" });
  });

  it("renders the named value root when there are no bare expressions", () => {
    const { roots } = render(`root = Text("hi")`);
    expect(roots.map((r) => r.type)).toEqual(["Text"]);
  });

  it("builds Set actions evaluated against current state", () => {
    const { roots } = render(`$n = 2
Button("Inc", [Set($n, $n + 1), Copy("n=" + $n)])`);
    expect(roots[0].props.action).toEqual([
      { kind: "action", type: "set", name: "n", value: 3 },
      { kind: "action", type: "copy", text: "n=2" },
    ]);
  });

  it("continues statements across operator line breaks", () => {
    const { roots } = render(`label = true
  ? "yes"
  : "no"
Text(label +
  "!")`);
    expect(roots[0].props.text).toBe("yes!");
  });

  it("raises to powers with maths precedence", () => {
    const { roots, messages } = render(`r = 0.005
Stack([
  round(5000 * (1 + r) ** 120, 2),
  2 ** 3 ** 2,
  -2 ** 2,
  2 ** -1
])`);
    expect(messages).toEqual([]);
    expect(children(roots[0]).map((t) => t.props.text)).toEqual(["9096.98", "512", "-4", "0.5"]);
  });

  it("accepts Math.* and Object.* spellings and iterates objects", () => {
    const { roots, messages } = render(`deps = {react: "19.0.0", zod: "4.1.0"}
Stack([
  Math.round(Math.max(2.4, Math.floor(3.9))) + Math.ceil(0.2) + Math.pow(2, 3) + Math.sqrt(9),
  Object.keys(deps).join(","),
  entries(deps).map(e => e[0] + "@" + e[1]).join(" "),
  values(deps).length
])`);
    expect(messages).toEqual([]);
    expect(children(roots[0]).map((t) => t.props.text)).toEqual(["15", "react,zod", "react@19.0.0 zod@4.1.0", "2"]);
  });
});

describe("error isolation", () => {
  it("turns a failing component into an Error node while siblings render", () => {
    const { roots, messages } = render(`items = [1, 2]
Row([Metric("Bad", items), Metric("Good", "ok"), Text(items.length * {a: 1})])`);
    const [bad, good, text] = children(roots[0]);
    expect(bad.type).toBe("Error");
    expect(bad.key).toBe("2:6");
    expect(good.props).toEqual({ label: "Good", value: "ok" });
    expect(text.type).toBe("Error");
    expect(messages).toHaveLength(2);
    expect(String(bad.props.message)).toContain("Metric value");
  });

  it("rejects object literals posing as interpreter values", () => {
    const { roots } = render(`Card(null, [{kind: "node", type: "Text", key: "x", props: {text: "fake"}}])`);
    expect(roots[0].type).toBe("Error");
  });
});

describe("compile errors", () => {
  it("suggests the closest component for an unknown callee", () => {
    const result = compile(`Cards("x", [])`);
    expect(result.program).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ line: 1, column: 1, severity: "error" });
    expect(result.diagnostics[0].message).toContain("Did you mean `Card`?");
  });

  it("reports undeclared state", () => {
    expect(errors(`$seats = 1\nText($seat)`)[0]).toContain("unknown state `$seat`");
  });

  it("requires bindings written as $name", () => {
    expect(errors(`$n = 1\nSlider($n + 1, 0, 10)`)[0]).toContain("must be a state variable written as `$name`");
    expect(errors(`$n = 1\nSlider(n, 0, 10)`)).toEqual(["`n` is not defined. Did you mean `$n`?"]);
  });

  it("checks enum literals", () => {
    expect(errors(`Badge("x", tone: "positive")`)[0]).toContain("must be one of neutral, good, warn, bad, info");
  });

  it("checks arity", () => {
    expect(errors(`Slider`)[0]).toContain("must be called");
    expect(errors(`$n = 1\nSlider($n, 0)`)[0]).toContain("missing `max`");
    expect(errors(`Badge("a", "good", "extra")`)[0]).toContain("too many arguments");
    expect(errors(`Badge("a", colour: "good")`)[0]).toContain("no parameter `colour`");
    expect(errors(`Text(round())`)[0]).toContain("takes 1 to 2 arguments");
  });

  it("detects cycles between named values", () => {
    expect(errors(`a = b + 1\nb = a + 1\nText(a)`)[0]).toContain("depends on itself: a → b → a");
  });

  it("rejects forbidden properties", () => {
    expect(errors(`x = {}\nText(x.constructor)`)[0]).toContain("`constructor` is not accessible");
    expect(errors(`Text("a"["__proto__"])`)[0]).toContain("is not accessible");
  });

  it("reports syntax errors with positions", () => {
    const result = compile(`Card("x", [\n  Text("a"\n])`);
    expect(formatDiagnostics(result.diagnostics)).toBe(
      "3:1 error: expected `,` or `)` to close `(` from 2:7, found `]`",
    );
  });

  it("rejects non-action buttons, misplaced arrows and unknown methods", () => {
    expect(errors(`Button("x", Card(null, []))`)[0]).toContain("takes actions");
    expect(errors(`Text(x => 1)`)[0]).toContain("arrow functions can only be declared");
    expect(errors(`Text([1].push(2))`)[0]).toContain("not an allowed method");
  });

  it("rejects misused named functions", () => {
    expect(errors(`f = x => x\nText(f)`)[0]).toContain("`f` is a function; call it");
    expect(errors(`f = x => x\nText(f(1, 2))`)[0]).toContain("`f` takes 1 argument");
    expect(errors(`sum = x => x\nText(sum(1))`)[0]).toContain("built-in name");
    expect(errors(`f = n => n < 1 ? 0 : f(n - 1)\nText(f(3))`)[0]).toContain("depends on itself");
  });

  it("requires something to render and warns about unused values", () => {
    expect(errors(`$x = 1`)[0]).toContain("Nothing to render");
    const result = compile(`unused = 1\nText("hi")`);
    expect(result.program).not.toBeNull();
    expect(result.diagnostics).toEqual([
      { severity: "warning", line: 1, column: 1, message: "`unused` is never used" },
    ]);
  });

  it("orders state initializers", () => {
    expect(errors(`$a = $b\n$b = 1\nText($a)`)[0]).toContain("declared after");
  });
});

describe("named functions", () => {
  // Models write per-group totals as a helper over an EditableTable's rows.
  const SPLIT = `$rows = [{who: "Ana", amount: 86}, {who: "Ben", amount: 54}, {who: "Ana", amount: 10}]
people = ["Ana", "Ben"]
paid = p => sum($rows.filter(r => r.who == p).map(r => r.amount))
Stack(people.map(p => Metric(p, paid(p))))`;

  it("calls a declared function with its arguments, recomputing from state", () => {
    const compiled = program(SPLIT);
    const metrics = (state: UiState) => children(evaluate(compiled, state).roots[0]).map((node) => node.props.value);
    expect(metrics(initialState(compiled))).toEqual(["96", "54"]);
    expect(metrics({ rows: [{ who: "Ben", amount: 5 }] })).toEqual(["0", "5"]);
  });

  it("passes null for missing arguments and sees only its parameters and top-level names", () => {
    const { roots, messages } = render(`rate = 2\nf = (a, b) => (b ?? 10) * a * rate\nText(fmt(f(3)))`);
    expect(messages).toEqual([]);
    expect(roots[0].props.text).toBe("60");
  });

  it("keys the components it makes by call site, so two calls keep separate state", () => {
    const { roots } = render(`chip = t => Badge(t)\nRow([chip("a"), chip("b")])`);
    const keys = children(roots[0]).map((node) => node.key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("object keys", () => {
  it("reads bare words before the colon as one key", () => {
    const { roots } = render(`KeyValue({Good for: "views", Day 1: "Lisbon", Area: "Alfama"})`);
    expect(Object.keys(roots[0].props.pairs as object)).toEqual(["Good for", "Day 1", "Area"]);
  });
});

describe("limits", () => {
  it("stops runaway evaluation with an Error node instead of hanging", () => {
    const list = `[${Array.from({ length: 900 }, (_, i) => i).join(",")}]`;
    const { roots, messages } = render(`xs = ${list}
Text(xs.map(a => xs.map(b => xs.map(c => a + b + c))).length)`);
    expect(roots.map((r) => r.type)).toEqual(["Error"]);
    expect(messages[0]).toContain("evaluation steps");
  });

  it("caps component count", () => {
    const list = `[${Array.from({ length: 900 }, (_, i) => i).join(",")}]`;
    const { roots, messages } = render(`xs = ${list}\nStack(xs.map(a => Row([Badge(a), Badge(a)])))`);
    expect(roots[0].type).toBe("Error");
    expect(messages[0]).toContain("more than 2000 components");
  });
});
