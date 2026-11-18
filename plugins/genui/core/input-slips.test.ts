import { describe, expect, it } from "vitest";
import { checkSpec } from "../fallback";
import {
  compile,
  compileStreaming,
  evaluate,
  formatDiagnostics,
  formMessage,
  initialState,
} from "./index";
import type { UiNode } from "./types";

// The block an agent wrote in a WoW Captain thread (BBP-9). It failed with
// "`TextArea` value must be a state variable" and "`TextInput` is not a
// component" followed by every component name.
const CAPTAIN_FORM = `Form("What should I start?", [
  TextArea({name: "work", label: "Work to start", placeholder: "e.g. Tune my EllesmereUI action bars and unit frames for the healer preset"}),
  TextInput({name: "repo", label: "Repo or project (Tasks key), if any", placeholder: "e.g. ~/git/wow-ui or WOW"}),
  TextArea({name: "rules", label: "Standing rules for me (optional, saved to CAPTAIN.md)", placeholder: "e.g. Always run review before shipping; never touch my live SavedVariables"})
])`;

const errors = (source: string) =>
  compile(source)
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.message);

function render(source: string, edit?: Record<string, string>) {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  const state = { ...initialState(result.program), ...edit };
  const { roots, diagnostics } = evaluate(result.program, state);
  expect(diagnostics).toEqual([]);
  return { roots, state, warnings: result.diagnostics.map((d) => d.message) };
}

function find(node: UiNode, type: string): UiNode[] {
  const found = node.type === type ? [node] : [];
  const props = node.props as Record<string, unknown>;
  for (const value of Object.values(props)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (typeof child === "object" && child !== null && "type" in child && "props" in child) {
        found.push(...find(child as UiNode, type));
      }
    }
  }
  return found;
}

describe("the Captain form", () => {
  it("renders its three fields with their labels and placeholders", () => {
    const { roots, state } = render(CAPTAIN_FORM);
    const [card] = roots;
    expect(card.type).toBe("Card");
    expect((card.props as { title: unknown }).title).toBe("What should I start?");
    const [form] = find(card, "Form");
    const fields = [...find(form, "TextArea"), ...find(form, "Input")].map((node) => node.props);
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Work to start",
          placeholder: expect.stringContaining("EllesmereUI"),
        }),
        expect.objectContaining({ label: "Repo or project (Tasks key), if any" }),
        expect.objectContaining({ label: "Standing rules for me (optional, saved to CAPTAIN.md)" }),
      ]),
    );
    expect(fields).toHaveLength(3);
    expect(state).toMatchObject({ work: "", repo: "", rules: "" });
  });

  it("puts each answer into the message under its label", () => {
    const { roots } = render(CAPTAIN_FORM, { work: "Tune the bars", repo: "WOW", rules: "" });
    const [form] = find(roots[0], "Form");
    expect(formMessage(form as Parameters<typeof formMessage>[0])).toBe(
      "Work to start: Tune the bars\nRepo or project (Tasks key), if any: WOW\nStanding rules for me (optional, saved to CAPTAIN.md): —",
    );
  });

  it("says what it corrected as warnings", () => {
    const { warnings } = render(CAPTAIN_FORM);
    expect(warnings.join("\n")).toMatch(/`TextInput` is written `Input`/);
    expect(warnings.join("\n")).toMatch(/\$work/);
    expect(errors(CAPTAIN_FORM)).toEqual([]);
  });
});

describe("the Captain form as the agent sees it", () => {
  it("passes check_ui and reports what was corrected", async () => {
    const { ok, report } = await checkSpec(CAPTAIN_FORM, async () => {
      throw new Error("no files");
    });
    expect(ok).toBe(true);
    expect(report).toMatch(/`TextInput` is written `Input`/);
  });

  it("compiles at every streamed prefix without throwing", () => {
    for (let end = 1; end <= CAPTAIN_FORM.length; end++) {
      expect(() => compileStreaming(CAPTAIN_FORM.slice(0, end))).not.toThrow();
    }
    expect(compileStreaming(CAPTAIN_FORM).program).not.toBeNull();
  });
});

describe("config-object field names", () => {
  const message = (source: string, edit: Record<string, string>) => {
    const { roots } = render(source, edit);
    const [form] = find(roots[0], "Form");
    return formMessage(form as Parameters<typeof formMessage>[0]);
  };

  it("keeps non-ASCII field names apart", () => {
    const source =
      'Card("x", [Form([Input({name: "имя", label: "Name"}), Input({name: "город", label: "City"})])])';
    const { state } = render(source);
    expect(Object.keys(state)).toHaveLength(2);
    const [name, city] = Object.keys(state);
    expect(message(source, { [name]: "Alice", [city]: "Paris" })).toBe("Name: Alice\nCity: Paris");
  });

  it("keeps names that normalize alike apart", () => {
    const source =
      'Card("x", [Form([Input({name: "x-y", label: "A"}), Input({name: "x y", label: "B"})])])';
    const { state } = render(source);
    expect(Object.keys(state)).toEqual(["x_y", "x_y2"]);
    expect(message(source, { x_y: "1", x_y2: "2" })).toBe("A: 1\nB: 2");
  });

  it("binds the same field name to the same state", () => {
    const { state } = render(
      'Card("x", [Input({name: "work", label: "A"}), TextArea({name: "work", label: "B"})])',
    );
    expect(Object.keys(state)).toEqual(["work"]);
  });

  it("binds a declared state the field name spells", () => {
    const { state } = render('$work = "draft"\nCard("x", [Input({name: "work", label: "Work"})])');
    expect(state).toEqual({ work: "draft" });
  });
});

describe("options given by name", () => {
  it("keeps the error for a positional value list beside named options", () => {
    expect(errors('Card("x", [Checklist(["a"], options: ["a", "b"])])').join("\n")).toMatch(
      /must be a state variable/,
    );
    expect(errors('Card("x", [Checklist(["a"], ["a", "b"])])').join("\n")).toMatch(
      /must be a state variable/,
    );
  });

  it("still binds a fresh state when only the options are given", () => {
    expect(errors('Card("x", [Checklist(options: ["a", "b"])])')).toEqual([]);
  });
});

describe("inputs given a literal value", () => {
  it("starts a TextArea at its literal text", () => {
    const { state, roots } = render(
      'Card("Notes", [Form([TextArea("Ring first", label: "Notes")])])',
    );
    expect(state).toEqual({ textarea: "Ring first" });
    const [form] = find(roots[0], "Form");
    expect(formMessage(form as Parameters<typeof formMessage>[0])).toBe("Notes: Ring first");
  });

  it("starts a Toggle at its literal boolean", () => {
    const { state } = render('Card("x", [Toggle(true, label: "On")])');
    expect(Object.values(state)).toContain(true);
  });

  it("starts a Select at a literal that is one of its options", () => {
    const { state } = render('Card("x", [Select("Pro", ["Basic", "Pro"], label: "Plan")])');
    expect(state).toEqual({ select: "Pro" });
  });

  it("does not take a label-like literal for a value", () => {
    expect(errors('Card("x", [Input("Email")])').join("\n")).toMatch(/must be a state variable/);
    expect(errors('Card("x", [Choice("Plan", ["Basic", "Pro"])])').join("\n")).toMatch(
      /must be a state variable/,
    );
  });

  it("keeps the error when the literal does not fit the input", () => {
    expect(errors('Card("x", [Slider("loud", 0, 10)])').join("\n")).toMatch(
      /must be a state variable/,
    );
  });
});

describe("an unknown component name", () => {
  it("suggests the closest components instead of listing all of them", () => {
    const [message] = errors('Card("x", [DatePicker($day)])');
    expect(message).toMatch(/`DateInput`/);
    expect(message).not.toMatch(/Components:/);
    expect(message.length).toBeLessThan(200);
  });

  it("stays short when nothing is close", () => {
    const [message] = errors('Card("x", [Zorblax()])');
    expect(message).not.toMatch(/Card, Row, Stack/);
    expect(message.length).toBeLessThan(160);
  });

  it("stays short for an unknown function", () => {
    const [message] = errors('Card("x", [Text(frobnicate(1))])');
    expect(message).not.toMatch(/Functions:/);
    expect(message.length).toBeLessThan(160);
  });
});
