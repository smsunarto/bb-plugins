import { describe, expect, it } from "vitest";
import { compile, initialState } from "./index";

const warnings = (src: string) => compile(src).diagnostics.filter((d) => d.severity === "warning").map((d) => d.message);
const errors = (src: string) => compile(src).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

describe("arguments packed into one config object", () => {
  it("unwraps the exact reply that failed: Table({columns, rows})", () => {
    const src = 'Card("t", [\n  Table(\n    {columns: ["№", "Задача"], rows: [\n      ["1", "Удалить старые группы"],\n      ["2", "Сверить составы"],\n    ]}\n  )\n])';
    const { program, diagnostics } = compile(src);
    expect(program).not.toBeNull();
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(warnings(src).some((w) => w.includes("named arguments"))).toBe(true);
  });

  it("works for other config-style components", () => {
    for (const src of [
      'Chart({type: "bar", labels: ["a", "b"], series: [1, 2]})',
      'Decision({options: [{name: "a"}], criteria: ["cost"]})',
      'Card({title: "t", children: [Text("x")]})',
    ]) {
      const { program, diagnostics } = compile(src);
      expect(program, src).not.toBeNull();
      expect(diagnostics.filter((d) => d.severity === "error"), src).toHaveLength(0);
      expect(warnings(src).some((w) => w.includes("named arguments")), src).toBe(true);
    }
  });

  it("never touches data-shaped objects: KeyValue and Json stay as they are", () => {
    expect(warnings('KeyValue({"Директория": "D:\\\\Science", "Тезисы": "готов"}')).toHaveLength(0);
    expect(errors('KeyValue({"Директория": "D:\\\\Science"})')).toHaveLength(0);
    expect(warnings('Json({"price": 5, "qty": 2})')).toHaveLength(0);
    expect(errors('Json({"price": 5, "qty": 2})')).toHaveLength(0);
  });

  it("keeps errors for objects with unknown keys, collisions, or healthy calls", () => {
    // A key that is not a parameter: the intent is no longer clear.
    expect(warnings('Table({columns: ["a"], rows: [["x"]], title: "t"})')).toHaveLength(0);
    expect(errors('Table({columns: ["a"], rows: [["x"]], title: "t"})').length).toBeGreaterThanOrEqual(1);
    // A key colliding with an already-supplied named argument.
    expect(warnings('Table(columns: ["a"], {rows: [["x"]]})')).toHaveLength(0);
    expect(errors('Table(columns: ["a"], {rows: [["x"]]})').length).toBeGreaterThanOrEqual(1);
    // A healthy single-object call (Scene's methods etc.) is not rewritten here.
    expect(warnings("Steps([{title: \"a\", detail: \"b\"}])")).toHaveLength(0);
    expect(errors("Steps([{title: \"a\", detail: \"b\"}])")).toHaveLength(0);
  });

  it("keeps its errors when a required parameter is still missing after the unwrap", () => {
    expect(errors('Table({columns: ["a"]})').length).toBeGreaterThanOrEqual(1);
  });
});

describe("config object on a binding parameter (regression)", () => {
  it("unwraps Input({value, label}) and declares the state", () => {
    const src = 'Form([Input({value: $addr, label: "Адрес"}), Choice($proto, ["SSH"], label: "Как")])';
    const { program, diagnostics } = compile(src);
    expect(program).not.toBeNull();
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(initialState(program!)).toMatchObject({ addr: "", proto: "" });
  });
});
