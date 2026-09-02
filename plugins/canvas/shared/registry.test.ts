import { test } from "bun:test";
import assert from "node:assert/strict";
import { isStatefulName } from "./source.ts";
import {
  componentNameSchema,
  componentNames,
  isComponentName,
  isStateful,
  registry,
  suggestComponentName,
} from "./registry.ts";

test("registry declares every v1 component", () => {
  assert.deepEqual([...componentNames].sort(), [
    "Ask",
    "BarChart",
    "Callout",
    "Card",
    "Checklist",
    "DiffView",
    "FileLink",
    "Grid",
    "LineChart",
    "PieChart",
    "Pill",
    "Row",
    "Section",
    "Select",
    "Source",
    "Stat",
    "Tab",
    "Table",
    "Tabs",
    "Todos",
    "Toggle",
    "UsageBar",
  ]);
});

test("stateful components all require an id prop", () => {
  for (const name of componentNames) {
    if (!isStateful(name)) continue;
    const result = registry[name].props.safeParse({});
    assert.equal(result.success, false, `${name} should reject a missing id`);
    const paths = result.error?.issues.map((issue) => issue.path.join(".")) ?? [];
    assert.ok(paths.includes("id"), `${name} should report the id path`);
  }
});

test("no registry prop is named style, className, or color", () => {
  for (const name of componentNames) {
    const keys = Object.keys(registry[name].props.shape);
    for (const forbidden of ["style", "className", "color"]) {
      assert.ok(!keys.includes(forbidden), `${name} exposes ${forbidden}`);
    }
  }
});

test("componentNameSchema and isComponentName agree", () => {
  assert.equal(componentNameSchema.safeParse("Table").success, true);
  assert.equal(componentNameSchema.safeParse("Tabel").success, false);
  assert.equal(isComponentName("Table"), true);
  assert.equal(isComponentName("toString"), false);
});

test("suggestComponentName finds a close name and ignores far ones", () => {
  assert.equal(suggestComponentName("Tabel"), "Table");
  assert.equal(suggestComponentName("card"), "Card");
  assert.equal(suggestComponentName("BarChar"), "BarChart");
  assert.equal(suggestComponentName("Widget"), undefined);
});

test("chart props accept Cursor's series shape", () => {
  const result = registry.BarChart.props.safeParse({
    categories: ["a", "b"],
    series: [{ name: "s", data: [1, 2], tone: "info" }],
    referenceLines: [{ value: 1.5, label: "target" }],
    beginAtZero: true,
  });
  assert.equal(result.success, true);
});

test("isStatefulName in source.ts mirrors the registry stateful flags", () => {
  for (const name of componentNames) {
    assert.equal(isStatefulName(name), isStateful(name), name);
  }
});
