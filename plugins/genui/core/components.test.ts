import { describe, expect, it } from "vitest";
import { compile, evaluate, formatDiagnostics, initialState, type Program } from "./index";
import type { Action, UiNode, UiState } from "./types";

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

describe("new components", () => {
  it("render tabs with one panel per label", () => {
    const { roots, messages } = render(`Card("Release", [
  Tabs(["Summary", "Risks"], [
    Text("Ships **Friday**"),
    Table(["Risk", "Impact"], [["Migration", Badge("high", tone: "bad")]])
  ])
])`);
    expect(messages).toEqual([]);
    const [tabs] = children(roots[0]);
    expect(tabs.type).toBe("Tabs");
    expect(tabs.props.labels).toEqual(["Summary", "Risks"]);
    expect(children(tabs).map((panel) => panel.type)).toEqual(["Text", "Table"]);
  });

  it("render steps from objects", () => {
    const items = [
      { title: "Design", status: "done" },
      { title: "Build", detail: "API first", status: "current" },
      { title: "Ship", status: "blocked" },
      { title: "Announce" },
    ];
    const { roots, messages } = render(`Steps(${JSON.stringify(items)})`);
    expect(messages).toEqual([]);
    expect(roots[0].type).toBe("Steps");
    expect(roots[0].props.items).toEqual(items);
  });

  it("render progress with optional max, label and tone", () => {
    const { roots } = render(`$done = 3\nProgress($done, 8, label: "Tasks", tone: "good")`);
    expect(roots[0].props).toEqual({ value: 3, max: 8, label: "Tasks", tone: "good" });
    expect(render(`Progress(42)`).roots[0].props).toEqual({ value: 42 });
  });

  it("render code and diffs as text", () => {
    const code = render("Code(`const x = 1\nexport default x`, \"ts\")").roots[0];
    expect(code.props).toEqual({ code: "const x = 1\nexport default x", language: "ts" });
    const patch = "--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-const x = 1\n+const x = 2";
    const diff = render(`Diff(${JSON.stringify(patch)})`).roots[0];
    expect(diff.props).toEqual({ patch });
  });

  it("bind a form: Input, Select and Checklist feed a Button's Send", () => {
    const source = `$name = ""
$env = "staging"
$checks = ["tests"]
checkOptions = ["tests", "lint", "types"]
Card("Deploy", [
  Input($name, label: "Release name", placeholder: "v1.2"),
  Select($env, ["staging", "production"], label: "Environment"),
  Checklist($checks, checkOptions, label: "Run first"),
  Button("Deploy", Send("Deploy " + $name + " to " + $env + " after " + $checks.join(", ")))
])`;
    const { roots, messages } = render(source, { name: "v2", env: "production", checks: ["tests", "lint"] });
    expect(messages).toEqual([]);
    const [input, select, checklist, button] = children(roots[0]);
    expect(input.props).toEqual({
      value: { kind: "binding", name: "name", value: "v2" },
      label: "Release name",
      placeholder: "v1.2",
    });
    expect(select.props.value).toEqual({ kind: "binding", name: "env", value: "production" });
    expect(select.props.options).toEqual(["staging", "production"]);
    expect(checklist.props.value).toEqual({ kind: "binding", name: "checks", value: ["tests", "lint"] });
    expect(button.props.action).toEqual([
      { kind: "action", type: "send", text: "Deploy v2 to production after tests, lint" },
    ] satisfies Action[]);
  });
});

describe("binding checks", () => {
  it("require bindings written as $name", () => {
    expect(errors(`$q = ""\nInput($q + "x")`)[0]).toContain("`Input` value must be a state variable written as `$name`");
    expect(errors(`Select("a", ["a", "b"])`)[0]).toContain("`Select` value must be a state variable");
    expect(errors(`$picked = []\nChecklist(picked, ["a"])`)).toEqual(["`picked` is not defined. Did you mean `$picked`?"]);
  });

  it("read losslessly convertible state and warn about it", () => {
    const checklist = compile(`$picked = "a"\nChecklist($picked, ["a", "b"])`);
    expect(checklist.diagnostics.map((d) => `${d.severity}: ${d.message}`)).toEqual([
      'warning: `Checklist` value needs a list state, but `$picked` starts as text; declare it as `$picked = []`',
    ]);
    expect(render(`$picked = "a"\nChecklist($picked, ["a", "b"])`).roots[0].props.value).toMatchObject({ value: ["a"] });
    expect(render(`$picked = ""\nChecklist($picked, ["a", "b"])`).roots[0].props.value).toMatchObject({ value: [] });
    expect(render(`$q = 0\nInput($q)`).roots[0].props.value).toMatchObject({ value: "0" });
    expect(render(`$n = "12"\nSlider($n, 0, 20)`).roots[0].props.value).toMatchObject({ value: 12 });
  });

  it("reject state that has no lossless reading", () => {
    expect(errors(`$env = ["a"]\nSelect($env, ["a", "b"])`)[0]).toContain(
      "`Select` value needs a text, number or boolean state, but `$env` starts as a list",
    );
    expect(errors(`$n = "many"\nSlider($n, 0, 20)`)[0]).toContain("`Slider` value needs a number state");
  });

  it("accept null as an empty state", () => {
    expect(render(`$env = null\nSelect($env, ["a", "b"])`).messages).toEqual([]);
  });

  it("reject state of the wrong type at evaluation time", () => {
    const source = `$picked = ""\nSelect($picked, ["a"])`;
    const { roots, messages } = render(source, { picked: ["a"] });
    expect(roots[0].type).toBe("Error");
    expect(messages).toEqual([
      "Select value needs a text, number or boolean state, but `$picked` holds a list; declare it as `$picked = \"\"`",
    ]);
  });

  it("reject Steps items that are not a list", () => {
    expect(errors(`Steps("Design, Build")`)).toEqual(["`Steps` items needs a list, got text"]);
    const { roots, messages } = render(`items = {title: "Design"}\nSteps(items)`);
    expect(roots[0].type).toBe("Error");
    expect(messages).toEqual(["Steps items needs a list, got an object"]);
  });
});

describe("checklist toggle", () => {
  // What a "toggle" Button does to a Checklist's list state.
  const source = `$picked = ["tests"]
options = ["tests", "lint", "types"]
Row(options.map(o => Button(o, Set($picked, $picked.includes(o) ? $picked.filter(p => p != o) : options.filter(x => x == o || $picked.includes(x))))))`;

  function setActions(state?: UiState): Action[] {
    return children(render(source, state).roots[0]).map((button) => (button.props.action as Action[])[0]);
  }

  it("removes a picked option and adds others in option order", () => {
    const [tests, lint, types] = setActions();
    expect(tests).toEqual({ kind: "action", type: "set", name: "picked", value: [] });
    expect(lint).toEqual({ kind: "action", type: "set", name: "picked", value: ["tests", "lint"] });
    expect(types).toEqual({ kind: "action", type: "set", name: "picked", value: ["tests", "types"] });
    expect(setActions({ picked: ["tests", "types"] })[1]).toEqual({
      kind: "action",
      type: "set",
      name: "picked",
      value: ["tests", "lint", "types"],
    });
  });
});
