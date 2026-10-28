import { describe, expect, it } from "vitest";
import { compile, evaluate, formatDiagnostics, initialState, toMarkdown } from "./index";
import type { UiState } from "./types";

function markdown(source: string, state?: UiState): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  return toMarkdown(evaluate(result.program, { ...initialState(result.program), ...state }).roots);
}

describe("toMarkdown: choose and edit", () => {
  it("OptionCards marks the picked option, or ticks several for a list state", () => {
    const options = `[{value: "oak", title: "Oak", detail: "light"}, {value: "walnut", title: "Walnut"}, "Ash"]`;
    expect(markdown(`$wood = "walnut"\nOptionCards($wood, ${options}, label: "Wood")`)).toBe(
      "Wood:\n- ○ Oak — light\n- ◉ Walnut\n- ○ Ash",
    );
    expect(markdown(`$woods = ["oak", "Ash"]\nOptionCards($woods, ${options})`)).toBe(
      "Woods:\n- [x] Oak — light\n- [ ] Walnut\n- [x] Ash",
    );
  });

  it("Swatches lists a palette plainly and marks a picker's choice regardless of case", () => {
    expect(markdown(`Swatches(["#0F172A", {value: "rebeccapurple", name: "Purple"}], label: "Brand")`)).toBe(
      "Brand:\n- `#0F172A`\n- Purple `rebeccapurple`",
    );
    expect(markdown(`$accent = "#0f172a"\nSwatches(["#0F172A", "teal"], $accent)`)).toBe(
      "Accent:\n- ◉ `#0F172A`\n- ○ `teal`",
    );
  });

  it("EditableTable is a table of the current rows; booleans read as ticks", () => {
    const source = `$bill = [{item: "Pizza", price: 24, shared: true}, {item: "Wine", price: null, shared: false}]
EditableTable($bill, ["item", {key: "price", label: "Price ($)", type: "number"}, "shared"], label: "Bill")`;
    expect(markdown(source)).toBe(
      "Bill:\n\n| Item | Price ($) | Shared |\n| --- | --- | --- |\n| Pizza | 24 | ✓ |\n| Wine |  | ✗ |",
    );
    expect(markdown(source, { bill: [] })).toBe("Bill:\n\n—");
  });

  it("FollowUps lists the prompts; Carousel reads its cards in order", () => {
    expect(markdown(`FollowUps(["Compare prices", "", "Plan a route"])`)).toBe("Follow-ups:\n- Compare prices\n- Plan a route");
    expect(markdown(`Carousel([Card("One", [Text("a")]), Card("Two", [Text("b")])])`)).toBe("**One**\n\na\n\n**Two**\n\nb");
  });
});
