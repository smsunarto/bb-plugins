import { describe, expect, it } from "vitest";
import { compile, evaluate, formatDiagnostics, formMessage, initialState } from "./index";
import { formFields } from "./form";
import type { UiNode, UiState } from "./types";

/** The message of the spec's first root, a Form. */
function message(source: string, state?: UiState): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  const { roots, diagnostics } = evaluate(result.program, state ?? initialState(result.program));
  expect(diagnostics).toEqual([]);
  const form: UiNode = roots[0];
  expect(form.type).toBe("Form");
  return formMessage(form);
}

describe("formMessage", () => {
  it("lists every field at any depth in document order", () => {
    expect(
      message(`$name = "Ada"
$size = "M"
$notes = "Ring first"
Form([
  Card("Order", [
    Row([Input($name, label: "Name"), Select($size, ["S", "M", "L"], label: "Size")]),
    Tabs(["More"], [Stack([Text("Anything else?"), TextArea($notes, label: "Notes")])])
  ]),
  Button("Reset", Set($name, ""))
], submit: "Order")`),
    ).toBe("Name: Ada\nSize: M\nNotes: Ring first");
  });

  it("labels unlabeled fields with their state name", () => {
    expect(
      message(`$tier = "Pro"
$when = "2026-10-09"
Form([Choice($tier, ["Basic", "Pro"]), DateInput($when)])`),
    ).toBe("tier: Pro\nwhen: 2026-10-09");
  });

  it("does not add a colon after a question or colon label", () => {
    expect(
      message(`$who = "Me"
$when = "Soon"
Form([Input($who, label: "Who should subscribe?"), Input($when, label: "Deadline:")])`),
    ).toBe("Who should subscribe? Me\nDeadline: Soon");
  });

  it("writes empty values as a dash, and an untouched multi-select as none of its options", () => {
    expect(
      message(`$name = "  "
$size = null
$tags = []
$stars = 0
Form([Input($name, label: "Name"), Select($size, ["S"], label: "Size"), Checklist($tags, ["a", "b"], label: "Tags"), Rating($stars, label: "Rating")])`),
    ).toBe("Name: —\nSize: —\nTags: none (options: a, b)\nRating: —");
  });

  it("joins lists, says Yes/No for booleans and formats numbers", () => {
    expect(
      message(`$tags = ["api", "web"]
$items = ["milk", "eggs"]
$notify = true
$public = false
$budget = 1234.567
$seats = 3
$stars = 4
Form([
  Checklist($tags, ["api", "web", "cli"], label: "Areas"),
  ListEditor($items, label: "Shopping"),
  Toggle($notify, "Notify me"),
  Toggle($public, "Public"),
  Slider($budget, 0, 5000, label: "Budget"),
  Stepper($seats, label: "Seats"),
  Rating($stars, label: "Rating")
])`),
    ).toBe("Areas: api, web (not: cli)\nShopping: milk, eggs\nNotify me: Yes\nPublic: No\nBudget: 1,234.57\nSeats: 3\nRating: 4");
  });

  it("tells the agent which options of a multi-select were not picked", () => {
    // Six boxes, the user picks 1, 3 and 5 (in any order): the agent learns 2, 4 and 6 were left.
    expect(
      message(`$picked = ["Five", "One", "Three"]
Form([Checklist($picked, ["One", "Two", "Three", "Four", "Five", "Six"], label: "Which ones?")])`),
    ).toBe("Which ones? One, Three, Five (not: Two, Four, Six)");
    expect(
      message(`$all = ["CSV", "JSON"]
Form([Checklist($all, ["CSV", "JSON"], label: "Formats")])`),
    ).toBe("Formats: CSV, JSON (all)");
  });

  it("reads OptionCards with a list state as a multi-select of its values, and with a single state as the pick", () => {
    expect(
      message(`$moods = ["sky"]
$hero = "meadow"
Form([
  OptionCards($moods, [{value: "sky", title: "Open sky"}, {value: "meadow", title: "Meadow"}, {title: "Hilltop"}], label: "Moods"),
  OptionCards($hero, [{value: "sky"}, {value: "meadow"}], label: "Hero")
])`),
    ).toBe("Moods: sky (not: meadow, Hilltop)\nHero: meadow");
  });

  it("keeps picks that are no longer options, after the options", () => {
    expect(
      message(`$tags = ["gone", "b"]
Form([Checklist($tags, ["a", "b"], label: "Tags")])`),
    ).toBe("Tags: b, gone (not: a)");
  });

  it("lists each field with its state name and whether the user types into it", () => {
    const result = compile(`$name = ""
$tags = []
Form([Input($name, label: "Name"), Checklist($tags, ["a"])])`);
    const form: UiNode = evaluate(result.program!, initialState(result.program!)).roots[0];
    expect(formFields(form)).toEqual([
      { name: "name", typed: true, line: "Name: —" },
      { name: "tags", typed: false, line: "tags: none (options: a)" },
    ]);
  });

  it("is empty for a form without fields", () => {
    expect(message(`Form([Text("Nothing to ask")])`)).toBe("");
  });

  it("still reads a legacy submit label, and ignores it", () => {
    expect(message(`$ok = true\nForm([Toggle($ok, "Ready")], submit: "Send answers")`)).toBe("Ready: Yes");
  });
});
