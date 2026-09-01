import { describe, expect, test } from "bun:test";
import { DROPDOWN_ALPHABET, HINT_ALPHABET } from "./hint-labels.ts";
import {
  activeTransition,
  isEditableProbe,
  isIdleTrigger,
  isViableCandidate,
  opensDropdown,
  type CandidateView,
  type DropdownProbe,
  type EditableProbe,
  type IdleKey,
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

describe("isIdleTrigger", () => {
  function idleKey(overrides: Partial<IdleKey> = {}): IdleKey {
    return {
      key: "f",
      code: "KeyF",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      editableTarget: false,
      ...overrides,
    };
  }

  test("plain f triggers outside an editable target only", () => {
    expect(isIdleTrigger(idleKey())).toBe(true);
    expect(isIdleTrigger(idleKey({ editableTarget: true }))).toBe(false);
  });

  test("shifted or non-f keys do not trigger", () => {
    expect(isIdleTrigger(idleKey({ key: "F", shiftKey: true }))).toBe(false);
    expect(isIdleTrigger(idleKey({ key: "g", code: "KeyG" }))).toBe(false);
  });

  test("ctrl and alt chords never trigger", () => {
    expect(isIdleTrigger(idleKey({ ctrlKey: true }))).toBe(false);
    expect(isIdleTrigger(idleKey({ altKey: true }))).toBe(false);
    expect(isIdleTrigger(idleKey({ metaKey: true }))).toBe(false);
  });

  test("Cmd+Shift+F triggers even inside an editable target", () => {
    const chord = { key: "F", metaKey: true, shiftKey: true } as const;
    expect(isIdleTrigger(idleKey({ ...chord, editableTarget: true }))).toBe(true);
    expect(isIdleTrigger(idleKey(chord))).toBe(true);
    expect(isIdleTrigger(idleKey({ ...chord, code: "KeyC", key: "C" }))).toBe(false);
    expect(isIdleTrigger(idleKey({ ...chord, altKey: true }))).toBe(false);
    expect(isIdleTrigger(idleKey({ ...chord, ctrlKey: true }))).toBe(false);
  });
});

describe("opensDropdown", () => {
  function dropdownProbe(attributes: Record<string, string>, tagName = "BUTTON"): DropdownProbe {
    return { tagName, getAttribute: (name) => attributes[name] ?? null };
  }

  test("aria-haspopup menu, listbox, and true open a dropdown", () => {
    expect(opensDropdown(dropdownProbe({ "aria-haspopup": "menu" }))).toBe(true);
    expect(opensDropdown(dropdownProbe({ "aria-haspopup": "listbox" }))).toBe(true);
    expect(opensDropdown(dropdownProbe({ "aria-haspopup": "true" }))).toBe(true);
    expect(opensDropdown(dropdownProbe({ "aria-haspopup": "dialog" }))).toBe(false);
  });

  test("a combobox opens a dropdown", () => {
    expect(opensDropdown(dropdownProbe({ role: "combobox" }))).toBe(true);
  });

  test("a plain button and a native select do not", () => {
    expect(opensDropdown(dropdownProbe({}))).toBe(false);
    expect(opensDropdown(dropdownProbe({ "aria-haspopup": "menu" }, "SELECT"))).toBe(false);
  });
});

describe("DROPDOWN_ALPHABET", () => {
  test("reorders the hint alphabet without changing its character set", () => {
    expect([...DROPDOWN_ALPHABET].sort()).toEqual([...HINT_ALPHABET].sort());
    expect(DROPDOWN_ALPHABET.startsWith("fjdk")).toBe(true);
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
