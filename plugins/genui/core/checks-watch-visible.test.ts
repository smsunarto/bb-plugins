import { describe, expect, it } from "vitest";
import {
  applyWatchers,
  compile,
  evaluate,
  evaluateChecks,
  formatDiagnostics,
  formFields,
  initialState,
  MAX_WATCH_PASSES,
  probeInteractions,
} from "./index";
import { checkSpec } from "../fallback";
import type { ComponentNode, UiState } from "./types";

function compileOk(source: string) {
  const result = compile(source);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  expect(formatDiagnostics(errors), source).toBe("");
  expect(result.program).not.toBeNull();
  return result;
}

describe("declarative validation (checks)", () => {
  it("evaluates shorthand and built-in validators cleanly", () => {
    expect(evaluateChecks("", ["required", "email"])).toEqual(["Required"]);
    expect(evaluateChecks("not-an-email", ["required", "email"])).toEqual(["Enter a valid email"]);
    expect(evaluateChecks("alice@example.com", ["required", "email"])).toEqual([]);

    expect(evaluateChecks("", ["url"])).toEqual([]);
    expect(evaluateChecks("ftp://example.com", ["url"])).toEqual(["Enter a valid URL"]);
    expect(evaluateChecks("https://example.com/docs", ["url"])).toEqual([]);

    expect(evaluateChecks("", ["numeric"])).toEqual([]);
    expect(evaluateChecks("abc", ["numeric"])).toEqual(["Enter a valid number"]);
    expect(evaluateChecks("1,250.5", ["numeric"])).toEqual([]);

    expect(evaluateChecks("abc", [{ type: "minLength", min: 5 }])).toEqual([
      "At least 5 characters",
    ]);
    expect(evaluateChecks("abcdef", [{ type: "maxLength", max: 4 }])).toEqual([
      "At most 4 characters",
    ]);
    expect(evaluateChecks(["a"], [{ type: "minLength", min: 2 }])).toEqual(["At least 2 items"]);
    expect(
      evaluateChecks(5, [
        { type: "min", min: 10 },
        { type: "max", max: 20 },
      ]),
    ).toEqual(["Must be at least 10"]);
    expect(
      evaluateChecks(25, [
        { type: "min", min: 10 },
        { type: "max", max: 20 },
      ]),
    ).toEqual(["Must be at most 20"]);
    expect(
      evaluateChecks("bad!", [{ type: "pattern", pattern: "^[a-z0-9-]+$", message: "Slug only" }]),
    ).toEqual(["Slug only"]);
    expect(evaluateChecks("ok-1", [{ type: "pattern", pattern: "^[a-z0-9-]+$" }])).toEqual([]);
  });

  it("supports cross-field, date comparison, expression, conditional, and json-render args syntax", () => {
    expect(
      evaluateChecks("abc", [{ type: "matches", other: "xyz", message: "Must match password" }]),
    ).toEqual(["Must match password"]);
    expect(evaluateChecks("xyz", [{ type: "equalTo", args: { other: "xyz" } }])).toEqual([]);
    expect(
      evaluateChecks("2026-05-01", [
        { type: "greaterThan", other: "2026-05-10", message: "End after start" },
      ]),
    ).toEqual(["End after start"]);
    expect(evaluateChecks("2026-05-12", [{ type: "greaterThan", other: "2026-05-10" }])).toEqual(
      [],
    );
    expect(evaluateChecks(5, [{ type: "lessThan", args: { other: 3 } }])).toEqual([
      "Must be less than 3",
    ]);
    expect(
      evaluateChecks("", [{ type: "requiredIf", when: true, message: "Needed when enabled" }]),
    ).toEqual(["Needed when enabled"]);
    expect(evaluateChecks("", [{ type: "requiredIf", args: { field: false } }])).toEqual([]);
    expect(evaluateChecks("", [{ type: "required", when: false }])).toEqual([]);
    expect(evaluateChecks("", [{ type: "required", enabled: true }])).toEqual(["Required"]);
    expect(evaluateChecks("hi", [{ valid: false, message: "Custom rule failed" }])).toEqual([
      "Custom rule failed",
    ]);
    expect(evaluateChecks("hi", [{ ok: true, message: "Should pass" }])).toEqual([]);
    expect(evaluateChecks(false, ["required"], "Toggle")).toEqual(["Required"]);
    expect(evaluateChecks(0, ["required"], "Rating")).toEqual(["Required"]);
    expect(evaluateChecks(0, ["required"], "Slider")).toEqual([]);
    expect(evaluateChecks("abc", [{ type: "minLength", args: { min: 5 } }])).toEqual([
      "At least 5 characters",
    ]);
  });

  it("coerces a single check to a list with a warning and rejects malformed checks at compile time", () => {
    const single = compileOk(`$email = ""\nInput($email, label: "Email", checks: "required")`);
    expect(
      single.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("checks expects a list"),
      ),
    ).toBe(true);

    const unknownType = compile(
      `$x = ""\nInput($x, label: "X", checks: [{type: "minLenght", min: 3}])`,
    );
    expect(unknownType.program).toBeNull();
    expect(formatDiagnostics(unknownType.diagnostics)).toContain("Did you mean `minLength`?");

    const missingParam = compile(`$x = ""\nInput($x, label: "X", checks: [{type: "minLength"}])`);
    expect(missingParam.program).toBeNull();
    expect(formatDiagnostics(missingParam.diagnostics)).toContain("missing `min`");

    const badRegex = compile(
      `$x = ""\nInput($x, label: "X", checks: [{type: "pattern", pattern: "[unclosed"}])`,
    );
    expect(badRegex.program).toBeNull();
    expect(formatDiagnostics(badRegex.diagnostics)).toContain("invalid `pattern` regex");

    const redosRegex = compile(
      `$x = ""\nInput($x, label: "X", checks: [{type: "pattern", pattern: "(a+)+$"}])`,
    );
    expect(redosRegex.program).toBeNull();
    expect(formatDiagnostics(redosRegex.diagnostics)).toContain("nested quantifiers");

    const emptyObj = compile(`$x = ""\nInput($x, label: "X", checks: [{message: "oops"}])`);
    expect(emptyObj.program).toBeNull();
    expect(formatDiagnostics(emptyObj.diagnostics)).toContain("needs `type:");
  });

  it("reports Form field errors and skips hidden fields via visible:", () => {
    const { program } = compileOk(`$type = "Personal"
$email = "bad"
$company = ""
Form([
  Choice($type, ["Personal", "Business"], label: "Type"),
  Input($email, label: "Email", checks: ["required", "email"]),
  Input($company, label: "Company", visible: $type == "Business", checks: ["required"])
])`);
    const initial = evaluate(program!, initialState(program!));
    const form = initial.roots[0] as ComponentNode<"Form">;
    expect(formFields(form.props.children)).toEqual([
      { name: "type", typed: false, line: "Type: Personal", errors: [] },
      { name: "email", typed: true, line: "Email: bad", errors: ["Enter a valid email"] },
    ]);

    const business = evaluate(program!, { type: "Business", email: "a@b.co", company: "" });
    const businessForm = business.roots[0] as ComponentNode<"Form">;
    expect(formFields(businessForm.props.children)).toEqual([
      { name: "type", typed: false, line: "Type: Business", errors: [] },
      { name: "email", typed: true, line: "Email: a@b.co", errors: [] },
      { name: "company", typed: true, line: "Company: —", errors: ["Required"] },
    ]);
  });
});

describe("declarative visibility (visible:)", () => {
  it("hides any component when falsy and short-circuits prop evaluation", () => {
    const { program } = compileOk(`$count = 0
$items = []
Card("Summary", [
  Metric("Average", fmt(100 / $count), visible: $count > 0),
  Text("Empty", visible: $count == 0),
  Callout("Has items", visible: $items.length)
])`);
    const zero = evaluate(program!, { count: 0, items: [] });
    expect(zero.diagnostics).toEqual([]);
    const card = zero.roots[0] as ComponentNode<"Card">;
    expect(card.props.children.map((n) => n.type)).toEqual(["Text"]);

    const positive = evaluate(program!, { count: 4, items: ["x"] });
    expect(positive.diagnostics).toEqual([]);
    const card2 = positive.roots[0] as ComponentNode<"Card">;
    expect(card2.props.children.map((n) => n.type)).toEqual(["Metric", "Callout"]);
  });

  it("works on top-level roots and rejects visible: on actions", () => {
    const { program } = compileOk(`$show = false\nCard("Hidden", [Text("Hi")], visible: $show)`);
    expect(evaluate(program!, { show: false }).roots).toEqual([]);
    expect(evaluate(program!, { show: true }).roots.length).toBe(1);

    const onAction = compile(`$x = 1\nButton("Go", Set($x, 2, visible: true))`);
    expect(onAction.program).toBeNull();
    expect(formatDiagnostics(onAction.diagnostics)).toContain("has no parameter `visible`");
  });
});

describe("reactive Watch rules", () => {
  it("updates dependent state when a watched state changes, including multi-step cascades", () => {
    const { program } = compileOk(`$country = "US"
$state = "CA"
$city = "SF"
states = {US: ["CA", "NY"], CA: ["ON", "BC"]}
cities = {CA: ["SF", "LA"], NY: ["NYC"], ON: ["Toronto"], BC: ["Vancouver"]}
Watch($country, Set($state, states[$country][0]))
Watch($state, Set($city, cities[$state][0]))
Card("Location", [
  Select($country, ["US", "CA"], label: "Country"),
  Select($state, states[$country], label: "State"),
  Select($city, cities[$state], label: "City")
])`);
    const prev: UiState = { country: "US", state: "CA", city: "SF" };
    const unchanged = applyWatchers(program!, prev, { ...prev });
    expect(unchanged.changed).toEqual([]);
    expect(unchanged.state).toEqual(prev);

    const moved = applyWatchers(program!, prev, { ...prev, country: "CA" });
    expect(moved.diagnostics).toEqual([]);
    expect(moved.changed).toEqual(["state", "city"]);
    expect(moved.state).toEqual({ country: "CA", state: "ON", city: "Toronto" });
  });

  it("supports multi-target Watch, conditional Set, lowercase coercion, and stops Watch cycles", () => {
    const coerced = compileOk(`$a = 1
$b = 2
$sum = 3
watch([$a, $b], Set($sum, $a + $b))
Card("Calc", [Stepper($a), Stepper($b), Metric("Sum", fmt($sum))])`);
    expect(
      coerced.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("written `Watch`"),
      ),
    ).toBe(true);
    const updated = applyWatchers(coerced.program!, { a: 1, b: 2, sum: 3 }, { a: 5, b: 2, sum: 3 });
    expect(updated.state).toEqual({ a: 5, b: 2, sum: 7 });

    const cyclic = compileOk(`$a = 0
$b = 0
Watch($a, Set($b, $a + 1))
Watch($b, Set($a, $b + 1))
Card("Cycle", [Stepper($a, min: 0, max: 5)])`);
    const res = applyWatchers(cyclic.program!, { a: 0, b: 0 }, { a: 1, b: 0 });
    expect(res.diagnostics.length).toBe(1);
    expect(res.diagnostics[0].message).toContain(`did not settle after ${MAX_WATCH_PASSES} passes`);
  });

  it("rejects non-Set actions and nested Watch calls at compile time", () => {
    const badAction = compile(`$a = "x"\nWatch($a, Send("nope"))\nCard("T", [Input($a)])`);
    expect(badAction.program).toBeNull();
    expect(formatDiagnostics(badAction.diagnostics)).toContain("can only run `Set($state, value)`");

    const nested = compile(`$a = "x"\n$b = ""\nCard("T", [Watch($a, Set($b, ""))])`);
    expect(nested.program).toBeNull();
    expect(formatDiagnostics(nested.diagnostics)).toContain("top level");
  });

  it("runs watchers inside probeInteractions and checkSpec", async () => {
    const goodSpec = `$cloud = "AWS"
$region = "us-east-1"
regions = {AWS: ["us-east-1", "eu-west-1"], GCP: ["us-central1"]}
Watch($cloud, Set($region, regions[$cloud][0]))
Card("Deploy", [
  Select($cloud, ["AWS", "GCP"], label: "Cloud"),
  Select($region, regions[$cloud], label: "Region")
])`;
    const checked = await checkSpec(goodSpec, async () => ({ ok: false, error: "unused" }));
    expect(checked.ok, checked.report).toBe(true);

    // Missing lookup key in a watcher fails probeInteractions when picking "Azure".
    const brokenSpec = `$cloud = "AWS"
$region = "us-east-1"
regions = {AWS: ["us-east-1"], GCP: ["us-central1"]}
Watch($cloud, Set($region, regions[$cloud][0]))
Card("Deploy", [
  Select($cloud, ["AWS", "GCP", "Azure"], label: "Cloud"),
  Text($region.toUpperCase())
])`;
    const { program } = compileOk(brokenSpec);
    const state = initialState(program!);
    const initial = evaluate(program!, state);
    const probed = probeInteractions(program!, state, initial);
    expect(probed.failures.length).toBeGreaterThan(0);
  });
});
