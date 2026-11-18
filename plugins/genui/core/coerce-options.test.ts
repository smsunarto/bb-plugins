import { describe, expect, it } from "vitest";
import { compile, initialState } from "./index";

const warnings = (src: string) => compile(src).diagnostics.filter((d) => d.severity === "warning").map((d) => d.message);
const errors = (src: string) => compile(src).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

describe("options given without a $state", () => {
  it("rewrites Checklist(options) around a fresh list state", () => {
    const { program, diagnostics } = compile('Card("t", [Checklist(["a", "b"])])');
    expect(program).not.toBeNull();
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(diagnostics.some((d) => d.severity === "warning" && d.message.includes("`$checklist`"))).toBe(true);
    expect(initialState(program!)).toMatchObject({ checklist: [] });
  });

  it("covers the exact reply that failed: a Card full of real options", () => {
    const src = 'Card("Тезисы", [\n  Checklist([\n    "Сборник индексируется в РИНЦ",\n    "Формат допускает список литературы",\n  ])\n])';
    const { program, diagnostics } = compile(src);
    expect(program).not.toBeNull();
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(initialState(program!)).toMatchObject({ checklist: [] });
  });

  it("works with named options and nested components", () => {
    const { program, diagnostics } = compile('Card("t", [Checklist(options: ["a"])])');
    expect(program).not.toBeNull();
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(diagnostics.some((d) => d.severity === "warning")).toBe(true);
    expect(initialState(program!)).toMatchObject({ checklist: [] });
  });

  it("picks the initial value from the component's state kind", () => {
    expect(initialState(compile('Choice(["a", "b"])').program!)).toMatchObject({ choice: "" });
    expect(initialState(compile('Radio(["a", "b"])').program!)).toMatchObject({ radio: "" });
    expect(initialState(compile('Select(["a", "b"])').program!)).toMatchObject({ select: "" });
    // OptionCards holds no fixed kind (scalar pick or list multi-pick); the
    // synthesized state starts as a scalar, the runtime's single-pick mode.
    expect(initialState(compile('OptionCards([{value: "a"}, {value: "b"}])').program!)).toMatchObject({
      optioncards: "",
    });
  });

  it("keeps an explicit state untouched", () => {
    const { program, diagnostics } = compile('$picked = []\nChecklist($picked, ["a", "b"])');
    expect(program).not.toBeNull();
    expect(warnings('$picked = []\nChecklist($picked, ["a", "b"])')).toHaveLength(0);
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(initialState(program!)).toMatchObject({ picked: [] });
  });

  it("does not fire for other shapes and components", () => {
    // Two positional arguments: which is which stops being unambiguous.
    expect(warnings('Checklist(["a"], "Pick")')).toHaveLength(0);
    expect(errors('Checklist(["a"], "Pick")').length).toBeGreaterThanOrEqual(1);
    // A value argument that is not a list gets its own errors.
    expect(warnings('Checklist("answer")')).toHaveLength(0);
    expect(errors('Checklist("answer")').length).toBeGreaterThanOrEqual(1);
    // Slider has no options parameter.
    expect(warnings("Slider(5)")).toHaveLength(0);
    // Required options that are not a list literal are not guessed.
    expect(warnings("Checklist($picked = [])")).toHaveLength(0);
  });
});

describe("options survive the rewrite (regression)", () => {
  it("keeps the options list in the rewritten call's arguments", () => {
    const { program } = compile('Checklist(["a", "b"])');
    const call = program!.roots[0] as unknown as { args: { type: string; items: { value: string }[] }[] };
    expect(call.args).toHaveLength(2);
    expect(call.args[0].type).toBe("state");
    expect(call.args[1].items.map((item) => item.value)).toEqual(["a", "b"]);
  });

  it("keeps positional options with a named label", () => {
    const { program } = compile('Checklist(["a", "b"], label: "Pick")');
    const call = program!.roots[0] as unknown as { args: unknown[]; named: { name: string }[] };
    expect(call.args).toHaveLength(2);
    expect(call.named.map((arg) => arg.name)).toEqual(["label"]);
  });
});
