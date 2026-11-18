import { describe, expect, it } from "vitest";
import { compile, initialState, type Program } from "./index";

const warnings = (src: string) => compile(src).diagnostics.filter((d) => d.severity === "warning").map((d) => d.message);
const errors = (src: string) => compile(src).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

function tabsCall(program: Program): { args: unknown[] } {
  // Card("t", [Tabs(…)]) → descend to the Tabs call.
  const card = program.roots[0] as unknown as { args: { type: string; items: unknown[] }[] };
  return card.args[1].items[0] as { args: unknown[] };
}

describe("Tabs given as one list of {title, children}", () => {
  it("splits tab cards into parallel labels and children", () => {
    const src = 'Card("t", [Tabs([{title: "ПК", children: [Text("a")]}, {label: "Консоль", children: [Text("b")]}])])';
    const { program, diagnostics } = compile(src);
    expect(program).not.toBeNull();
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(diagnostics.some((d) => d.severity === "warning" && d.message.includes("parallel"))).toBe(true);
    const args = tabsCall(program!).args as unknown as { type: string; items: { value?: string }[] }[];
    expect(args).toHaveLength(2);
    expect(args[0].items.map((item) => item.value)).toEqual(["ПК", "Консоль"]);
    expect(args[1].items).toHaveLength(2);
  });

  it("covers the exact reply that failed: real tab cards with Steps and Lists", () => {
    const src = 'Card("Beast vs One Pro", [\n  Tabs([\n    {title: "🟣 VITURE Beast", children: [List([{title: "✓ Железо", tone: "good"}])]},\n    {title: "🕶 XREAL One Pro", children: [Steps([{title: "Шаг", detail: "Детали"}])]},\n  ])\n])';
    const { program, diagnostics } = compile(src);
    expect(program).not.toBeNull();
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("keeps the parallel-list form untouched", () => {
    const src = 'Tabs(["A", "B"], [Text("a"), Text("b")])';
    const { program, diagnostics } = compile(src);
    expect(program).not.toBeNull();
    expect(warnings(src)).toHaveLength(0);
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("keeps its errors for items it cannot split safely", () => {
    // An extra key makes the intended layout a guess.
    expect(warnings('Tabs([{title: "A", children: [Text("x")], tone: "good"}])')).toHaveLength(0);
    expect(errors('Tabs([{title: "A", children: [Text("x")], tone: "good"}])').length).toBeGreaterThanOrEqual(1);
    // A missing children key leaves nothing to split.
    expect(warnings('Tabs([{title: "A"}])')).toHaveLength(0);
    expect(errors('Tabs([{title: "A"}])').length).toBeGreaterThanOrEqual(1);
  });
});

describe("inputs bound to states that are never declared", () => {
  it("declares the state an input binds to, with the kind's neutral initial", () => {
    const src = 'Card("t", [Form([Input($addr, "Адрес"), Choice($proto, ["SSH", "SMB"], label: "Как"), TextArea($note, "Заметки")])])';
    const { program, diagnostics } = compile(src);
    expect(program).not.toBeNull();
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(warnings(src).filter((w) => w.includes("$addr")).length).toBe(1);
    expect(initialState(program!)).toMatchObject({ addr: "", proto: "", note: "" });
  });

  it("covers the exact reply that failed: UniDesk connection form", () => {
    const src = 'Card("Данные для подключения", [Form([\n  Input($addr, "Адрес или имя сервера", "напр. 192.168.0.20"),\n  Choice($proto, ["SSH", "SMB-папка"], label: "Как подключаться"),\n  TextArea($note, "Что за проект")\n])])';
    const { program, diagnostics } = compile(src);
    expect(program).not.toBeNull();
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(initialState(program!)).toMatchObject({ addr: "", proto: "", note: "" });
  });

  it("accepts the bare spelling and rewrites it to a state", () => {
    const src = 'Form([Input(addr, "Адрес")])';
    const { program, diagnostics } = compile(src);
    expect(program).not.toBeNull();
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(warnings(src).some((w) => w.includes("$addr"))).toBe(true);
    expect(initialState(program!)).toMatchObject({ addr: "" });
  });

  it("picks the initial from the state kind: number slider, list checklist", () => {
    expect(initialState(compile("Slider($level, 0, 100)").program!)).toMatchObject({ level: 0 });
    expect(initialState(compile('Checklist($picked, ["a", "b"])').program!)).toMatchObject({ picked: [] });
  });

  it("leaves declared states and named-value mixups alone", () => {
    expect(warnings('$addr = "x"\nInput($addr, "Адрес")')).toHaveLength(0);
    // `$addr` where `addr` is a named value is a genuine mixup: keep the error
    // (the named value itself going unused is just its own quiet warning).
    expect(warnings('addr = "x"\nInput($addr, "Адрес")').some((w) => w.includes("binds"))).toBe(false);
    expect(errors('addr = "x"\nInput($addr, "Адрес")').length).toBeGreaterThanOrEqual(1);
  });
});

describe("binding named arguments rewritten to states (regression)", () => {
  it("rewrites a bare ident inside a named binding argument", () => {
    const src = 'Form([Checklist(value: picked, options: ["a", "b"])])';
    const { program, diagnostics } = compile(src);
    expect(program).not.toBeNull();
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(initialState(program!)).toMatchObject({ picked: [] });
  });
});
