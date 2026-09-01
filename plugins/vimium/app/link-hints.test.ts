import { describe, expect, test } from "bun:test";
import {
  activeTransition,
  isEditableProbe,
  isViableCandidate,
  type CandidateView,
  type EditableProbe,
} from "./link-hints.ts";

function probe(overrides: Partial<EditableProbe> = {}): EditableProbe {
  return {
    tagName: "DIV",
    isContentEditable: false,
    getAttribute: () => null,
    closest: () => null,
    ...overrides,
  };
}

describe("isEditableProbe", () => {
  test("form fields are editable", () => {
    expect(isEditableProbe(probe({ tagName: "INPUT" }))).toBe(true);
    expect(isEditableProbe(probe({ tagName: "TEXTAREA" }))).toBe(true);
    expect(isEditableProbe(probe({ tagName: "SELECT" }))).toBe(true);
  });

  test("contenteditable and role=textbox are editable", () => {
    expect(isEditableProbe(probe({ isContentEditable: true }))).toBe(true);
    expect(
      isEditableProbe(probe({ getAttribute: (name) => (name === "role" ? "textbox" : null) })),
    ).toBe(true);
  });

  test("a descendant of a rich-text editor is editable", () => {
    expect(
      isEditableProbe(
        probe({
          closest: (selectors) => (selectors.includes("contenteditable") ? {} : null),
        }),
      ),
    ).toBe(true);
    expect(
      isEditableProbe(
        probe({ closest: (selectors) => (selectors.includes("textbox") ? {} : null) }),
      ),
    ).toBe(true);
  });

  test("a plain element is not editable", () => {
    expect(isEditableProbe(probe())).toBe(false);
    expect(isEditableProbe(probe({ tagName: "BUTTON" }))).toBe(false);
  });
});

describe("activeTransition", () => {
  const labels = ["sa", "sd", "fa"];

  test("modifier-only keydowns are ignored", () => {
    for (const key of ["Shift", "Control", "Alt", "Meta"]) {
      expect(activeTransition(labels, "", key)).toEqual({ kind: "ignore" });
    }
  });

  test("Escape exits", () => {
    expect(activeTransition(labels, "s", "Escape")).toEqual({ kind: "exit" });
  });

  test("Backspace drops the last typed character", () => {
    expect(activeTransition(labels, "s", "Backspace")).toEqual({ kind: "retype", typed: "" });
    expect(activeTransition(labels, "", "Backspace")).toEqual({ kind: "retype", typed: "" });
  });

  test("a key outside the alphabet exits", () => {
    expect(activeTransition(labels, "", "q")).toEqual({ kind: "exit" });
    expect(activeTransition(labels, "", "Enter")).toEqual({ kind: "exit" });
    expect(activeTransition(labels, "", "ArrowDown")).toEqual({ kind: "exit" });
  });

  test("a matching prefix narrows, case-insensitively", () => {
    expect(activeTransition(labels, "", "s")).toEqual({ kind: "retype", typed: "s" });
    expect(activeTransition(labels, "", "S")).toEqual({ kind: "retype", typed: "s" });
  });

  test("a prefix nothing matches exits", () => {
    expect(activeTransition(labels, "f", "d")).toEqual({ kind: "exit" });
  });

  test("an exact label activates", () => {
    expect(activeTransition(labels, "s", "d")).toEqual({ kind: "activate", label: "sd" });
    expect(activeTransition(["s"], "", "s")).toEqual({ kind: "activate", label: "s" });
  });
});

describe("isViableCandidate", () => {
  function view(overrides: Partial<CandidateView> = {}): CandidateView {
    return {
      clickableBeyondTabindex: true,
      tabindex: null,
      disabled: false,
      insideAriaHidden: false,
      rect: { top: 10, left: 10, width: 40, height: 20 },
      viewportWidth: 1024,
      viewportHeight: 768,
      display: "inline-block",
      visibility: "visible",
      visibleToUser: null,
      ...overrides,
    };
  }

  test("a visible clickable element is viable", () => {
    expect(isViableCandidate(view())).toBe(true);
  });

  test("tabindex -1 disqualifies unless the element is otherwise clickable", () => {
    expect(isViableCandidate(view({ tabindex: "-1", clickableBeyondTabindex: false }))).toBe(
      false,
    );
    expect(isViableCandidate(view({ tabindex: "-1" }))).toBe(true);
    expect(isViableCandidate(view({ tabindex: "0", clickableBeyondTabindex: false }))).toBe(true);
  });

  test("disabled and aria-hidden elements are not viable", () => {
    expect(isViableCandidate(view({ disabled: true }))).toBe(false);
    expect(isViableCandidate(view({ insideAriaHidden: true }))).toBe(false);
  });

  test("zero-size and offscreen rects are not viable", () => {
    expect(isViableCandidate(view({ rect: { top: 10, left: 10, width: 0, height: 20 } }))).toBe(
      false,
    );
    expect(isViableCandidate(view({ rect: { top: -30, left: 10, width: 40, height: 20 } }))).toBe(
      false,
    );
    expect(isViableCandidate(view({ rect: { top: 800, left: 10, width: 40, height: 20 } }))).toBe(
      false,
    );
    expect(isViableCandidate(view({ rect: { top: 10, left: 2000, width: 40, height: 20 } }))).toBe(
      false,
    );
  });

  test("hidden computed styles are not viable", () => {
    expect(isViableCandidate(view({ display: "none" }))).toBe(false);
    expect(isViableCandidate(view({ visibility: "hidden" }))).toBe(false);
  });

  test("checkVisibility overrules element-level styles, absent API changes nothing", () => {
    expect(isViableCandidate(view({ visibleToUser: false }))).toBe(false);
    expect(isViableCandidate(view({ visibleToUser: true }))).toBe(true);
    expect(isViableCandidate(view({ visibleToUser: null }))).toBe(true);
  });
});
