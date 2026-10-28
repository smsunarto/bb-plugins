import { describe, expect, it } from "vitest";
import {
  blankRow,
  cardOptions,
  followUpPrompts,
  parseNumberInput,
  setCell,
  swatchColors,
  tableColumns,
  tableRows,
  togglePick,
} from "./choose-logic";

describe("cardOptions", () => {
  it("reads scalars and objects, falling back to the title as value", () => {
    expect(cardOptions(["Oak", { value: 2, title: "Walnut", detail: "darker", image: "a.jpg", icon: "Home" }, { title: "Ash" }])).toEqual([
      { value: "Oak", title: "Oak", detail: null, image: null, icon: null },
      { value: 2, title: "Walnut", detail: "darker", image: "a.jpg", icon: "Home" },
      { value: "Ash", title: "Ash", detail: null, image: null, icon: null },
    ]);
  });

  it("skips options still streaming in and refuses a non-list", () => {
    expect(cardOptions([{}, { detail: "no value yet" }, null])).toEqual([]);
    expect(cardOptions("Oak")).toBeNull();
  });
});

describe("togglePick", () => {
  const options = ["a", "b", "c"];

  it("adds in option order and keeps preset non-options after them", () => {
    expect(togglePick(["c", "x"], "a", options)).toEqual(["a", "c", "x"]);
  });

  it("removes a picked option", () => {
    expect(togglePick(["a", "c"], "a", options)).toEqual(["c"]);
  });
});

describe("swatchColors", () => {
  const isColor = (value: string) => /^#[0-9a-f]{3,8}$/i.test(value) || value === "rebeccapurple";

  it("keeps colours the predicate accepts, with their names, and lists the rest", () => {
    expect(swatchColors([" #FFF ", { value: "rebeccapurple", name: "Purple" }, "blurple", 12], isColor)).toEqual({
      colors: [
        { value: "#FFF", name: null },
        { value: "rebeccapurple", name: "Purple" },
      ],
      invalid: ["blurple", "12"],
    });
  });

  it("skips objects whose value has not arrived yet", () => {
    expect(swatchColors([{}, { name: "Sky" }], isColor)).toEqual({ colors: [], invalid: [] });
  });
});

describe("tableColumns", () => {
  const rows = [
    { item: "Pizza", price: null, shared: true },
    { item: "Wine", price: 18, shared: false },
  ];

  it("infers missing types from the first filled cell and labels keys", () => {
    expect(tableColumns(["item", { key: "price", label: "Price ($)" }, "shared", "note"], rows)).toEqual([
      { key: "item", label: "Item", type: "text" },
      { key: "price", label: "Price ($)", type: "number" },
      { key: "shared", label: "Shared", type: "boolean" },
      { key: "note", label: "Note", type: "text" },
    ]);
  });

  it("an explicit type wins; keyless and repeated columns are skipped", () => {
    expect(tableColumns([{ key: "price", type: "text" }, {}, "price"], rows)).toEqual([
      { key: "price", label: "Price", type: "text" },
    ]);
  });
});

describe("rows", () => {
  const columns = tableColumns(["item", { key: "price", type: "number" }, { key: "paid", type: "boolean" }], []);

  it("reads an empty state as no rows and refuses non-object rows", () => {
    expect(tableRows(null)).toEqual([]);
    expect(tableRows([{ a: 1 }, "b"])).toBeNull();
  });

  it("a blank row has every column, so spec expressions never read a missing key", () => {
    expect(blankRow(columns)).toEqual({ item: "", price: null, paid: false });
  });

  it("setting a cell keeps the row's other keys, shown or not", () => {
    expect(setCell([{ item: "Tea", id: 7 }, { item: "Cake" }], 0, "item", "Coffee")).toEqual([{ item: "Coffee", id: 7 }, { item: "Cake" }]);
  });
});

describe("parseNumberInput", () => {
  it("reads plain, grouped and decimal-comma numbers", () => {
    expect(parseNumberInput("12")).toBe(12);
    expect(parseNumberInput("-3.5")).toBe(-3.5);
    expect(parseNumberInput("1,234.5")).toBe(1234.5);
    expect(parseNumberInput("1,234")).toBe(1234);
    expect(parseNumberInput("3,5")).toBe(3.5);
    expect(parseNumberInput("0,250")).toBe(0.25);
    expect(parseNumberInput(" 1 000 ")).toBe(1000);
    expect(parseNumberInput(".5")).toBe(0.5);
  });

  it("an empty field is null; half-typed or invalid text is undefined", () => {
    expect(parseNumberInput("  ")).toBeNull();
    expect(parseNumberInput("-")).toBeUndefined();
    expect(parseNumberInput("1.")).toBeUndefined();
    expect(parseNumberInput("12abc")).toBeUndefined();
    expect(parseNumberInput("1e400")).toBeUndefined();
  });
});

describe("followUpPrompts", () => {
  it("keeps trimmed text prompts once each", () => {
    expect(followUpPrompts([" Why? ", "", { text: "x" }, 3, "Why?"])).toEqual(["Why?", "3"]);
  });
});
