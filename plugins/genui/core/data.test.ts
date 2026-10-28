import { describe, expect, it } from "vitest";
import { LIMITS } from "./catalog";
import {
  collectLoads,
  compile,
  dataKey,
  evaluate,
  formatDiagnostics,
  initialState,
  MAX_SNIPPET_LINES,
  parseDataFile,
  type LoadedData,
  type Program,
} from "./index";
import type { UiNode, Value } from "./types";

function program(source: string): Program {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  return result.program;
}

function errors(source: string): string[] {
  const result = compile(source);
  expect(result.program).toBeNull();
  return result.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
}

function parsed(path: string, text: string): Value {
  const result = parseDataFile(path, text);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function failure(path: string, text: string): string {
  const result = parseDataFile(path, text);
  if (result.ok) throw new Error(`expected ${path} to fail, got ${JSON.stringify(result.value)}`);
  return result.error;
}

function children(node: UiNode): UiNode[] {
  return node.props.children as UiNode[];
}

describe("Load validation", () => {
  it("accepts a plain string path", () => {
    expect(compile('Table(["a"], Load("data/rows.json"))').program).not.toBeNull();
    expect(compile("Text(Load(`notes.md`))").program).not.toBeNull();
  });

  it("rejects computed paths so hosts can fetch before evaluating", () => {
    const literalOnly = expect.stringContaining("`Load` takes a plain string path");
    expect(errors('name = "x"\nText(Load(name + ".json"))')).toEqual([literalOnly]);
    expect(errors('$file = "a.csv"\nText(Load($file))')).toEqual([literalOnly]);
    expect(errors('$n = 1\nText(Load(`part-${$n}.json`))')).toEqual([literalOnly]);
    expect(errors("Text(Load(42))")).toEqual([literalOnly]);
    expect(errors('Text(Load(""))')).toEqual(["`Load` needs a file path"]);
  });

  it("takes exactly one argument", () => {
    expect(errors("Text(Load())")[0]).toContain("`Load` takes 1 argument");
    expect(errors('Text(Load("a.json", "b.json"))')[0]).toContain("`Load` takes 1 argument");
  });

  it("suggests the right casing", () => {
    expect(errors('Text(load("a.json"))')[0]).toContain("Did you mean `Load`?");
  });
});

describe("Snippet validation", () => {
  it("accepts a literal path, positional or named", () => {
    expect(compile('Snippet("src/app.ts", 10, 20)').program).not.toBeNull();
    expect(compile("Snippet(`src/app.ts`)").program).not.toBeNull();
    expect(compile('Snippet(from: 3, path: "src/app.ts")').program).not.toBeNull();
  });

  it("rejects computed paths so hosts can fetch before evaluating", () => {
    const literalOnly = expect.stringContaining("`Snippet` takes its path as a literal string");
    expect(errors('name = "a.ts"\nSnippet(name)')).toEqual([literalOnly]);
    expect(errors('$file = "a.ts"\nSnippet($file)')).toEqual([literalOnly]);
    expect(errors('$n = 1\nSnippet(`part-${$n}.ts`)')).toEqual([literalOnly]);
    expect(errors('Snippet(path: "src/" + "a.ts")')).toEqual([literalOnly]);
    expect(errors('Snippet("")')).toEqual(["`Snippet` needs a file path"]);
  });
});

describe("collectLoads", () => {
  const load = (path: string) => ({ path, raw: false });
  const raw = (path: string) => ({ path, raw: true });

  it("lists literal paths in source order without duplicates", () => {
    const compiled = program(`$rows = Load("b.csv")
summary = Load("a.json")
Card("Report", [
  Text(summary.title),
  Table(["x"], Load("b.csv").map(r => [r.x])),
  Text(Load("c.txt"))
])`);
    expect(collectLoads(compiled)).toEqual([load("b.csv"), load("a.json"), load("c.txt")]);
  });

  it("finds loads inside lambdas, templates and named arguments", () => {
    const compiled = program('Text(`${[1].map(i => Load("x.json").length).join("")}`, tone: Load("tone.txt"))');
    expect(collectLoads(compiled)).toEqual([load("x.json"), load("tone.txt")]);
  });

  it("requests Snippet files raw, apart from parsed loads of the same file", () => {
    const compiled = program(`Card("Config", [
  Snippet("cfg.json", 1, 5),
  Text(Load("cfg.json").name),
  Snippet(from: 6, path: "cfg.json"),
  Snippet("src/app.ts")
])`);
    expect(collectLoads(compiled)).toEqual([raw("cfg.json"), load("cfg.json"), raw("src/app.ts")]);
  });

  it("keys raw and parsed reads apart, whatever the path", () => {
    expect(dataKey(load("a.json"))).not.toBe(dataKey(raw("a.json")));
    expect(dataKey(load("raw:a.json"))).not.toBe(dataKey(raw("a.json")));
    expect(dataKey(raw("load:a.json"))).not.toBe(dataKey(load("a.json")));
  });

  it("is empty when nothing is loaded", () => {
    expect(collectLoads(program('Text("hi")'))).toEqual([]);
  });
});

describe("parseDataFile", () => {
  it("parses JSON", () => {
    expect(parsed("data/report.JSON", '{"total": 3, "items": [1, null]}')).toEqual({ total: 3, items: [1, null] });
  });

  it("parses SARIF and HAR files, which are JSON under their own extensions", () => {
    expect(parsed("eslint.sarif", '{"version": "2.1.0", "runs": []}')).toEqual({ version: "2.1.0", runs: [] });
    expect(parsed("page.HAR", '{"log": {"entries": []}}')).toEqual({ log: { entries: [] } });
    expect(failure("page.har", "{")).toMatch(/^invalid JSON: /);
  });

  it("reports malformed JSON without throwing", () => {
    expect(failure("a.json", '{"total": ')).toMatch(/^invalid JSON: /);
  });

  it("parses JSON lines, skipping blank lines", () => {
    expect(parsed("events.jsonl", '{"a":1}\n\n{"a":2}\r\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parsed("events.ndjson", "1\n2")).toEqual([1, 2]);
    expect(failure("events.jsonl", '{"a":1}\n{oops}')).toBe("line 2 is not valid JSON");
  });

  it("parses CSV with RFC 4180 quoting and typed cells", () => {
    const csv = [
      "name,amount,active,note,zip",
      'Acme,1200,true,"says ""hi"", twice",02134',
      '"Multi\nline",-3.5e2,FALSE,,',
      "Plain, 7 ,false,text,0",
    ].join("\r\n");
    expect(parsed("sales.csv", csv)).toEqual([
      { name: "Acme", amount: 1200, active: true, note: 'says "hi", twice', zip: "02134" },
      { name: "Multi\nline", amount: -350, active: false, note: null, zip: null },
      { name: "Plain", amount: 7, active: false, note: "text", zip: 0 },
    ]);
  });

  it("fills missing trailing CSV cells with null and rejects extra ones", () => {
    expect(parsed("a.csv", "a,b\n1")).toEqual([{ a: 1, b: null }]);
    expect(failure("a.csv", "a,b\n1,2,3")).toBe("row 1 has 3 cells; the header has 2");
  });

  it("reports malformed CSV quoting", () => {
    expect(failure("a.csv", 'a,b\n"open,2')).toBe("a quoted field starting on line 2 never closes");
    expect(failure("a.csv", 'a\n"x"y')).toBe("unexpected text after a closing quote on line 2");
    expect(failure("a.csv", "a,a\n1,2")).toBe('the header names column "a" twice');
  });

  it("parses TSV by tabs", () => {
    expect(parsed("a.tsv", "city\tpop\nRome\t2873000\n")).toEqual([{ city: "Rome", pop: 2873000 }]);
  });

  it("keeps a __proto__ column as plain data", () => {
    const [row] = parsed("a.csv", "__proto__,x\n1,2") as Record<string, Value>[];
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.hasOwn(row, "__proto__")).toBe(true);
  });

  it("returns other files as text", () => {
    expect(parsed("notes.md", "\uFEFF# Title\n")).toBe("# Title\n");
    expect(parsed("README", "plain")).toBe("plain");
  });

  it("reads .xml as a JUnit report and refuses other XML", () => {
    expect(parsed("reports/junit.XML", '<testsuites><testcase classname="a" name="t" time="0.5"/></testsuites>')).toEqual([
      { name: "t", status: "passed", suite: "a", ms: 500 },
    ]);
    expect(failure("pom.xml", "<project/>")).toMatch(/^only JUnit test reports are read from \.xml files/);
    expect(failure("bad.xml", "<testsuites>")).toBe("line 1: <testsuites> never closes");
  });

  it("caps lists in a file at the loaded-list limit, above the evaluator's", () => {
    const rows = Array.from({ length: LIMITS.loadedListLength + 1 }, (_, i) => i);
    expect(failure("a.json", JSON.stringify(rows))).toBe(
      `the file has ${LIMITS.loadedListLength + 1} rows; the limit is ${LIMITS.loadedListLength}`,
    );
    expect(failure("a.csv", ["n", ...rows].join("\n"))).toContain(`${LIMITS.loadedListLength + 1} rows`);
    expect(failure("a.json", JSON.stringify({ deep: { rows } }))).toBe(
      `a list in the file has ${LIMITS.loadedListLength + 1} items; the limit is ${LIMITS.loadedListLength}`,
    );
    expect(parseDataFile("a.json", JSON.stringify(rows.slice(1))).ok).toBe(true);
  });

  it("passes a loaded list longer than the evaluator's limit whole, but won't iterate it", () => {
    const loaded = parseDataFile("big.json", JSON.stringify(Array.from({ length: LIMITS.listLength + 1 }, (_, i) => ({ i }))));
    const data = new Map<string, LoadedData>([[dataKey({ path: "big.json", raw: false }), loaded]]);
    const run = (source: string) => {
      const compiled = program(source);
      return evaluate(compiled, initialState(compiled, data), data);
    };
    const whole = run('Json(Load("big.json"))');
    expect(whole.diagnostics).toEqual([]);
    expect((whole.roots[0].props.value as Value[]).length).toBe(LIMITS.listLength + 1);
    const mapped = run('Text(Load("big.json").map(r => r.i).length)');
    expect(mapped.roots[0].type).toBe("Error");
    expect(String(mapped.roots[0].props.message)).toContain(`lists are limited to ${LIMITS.listLength} items`);
  });

  it("rejects data posing as interpreter values", () => {
    for (const kind of ["node", "action", "binding"]) {
      const fake = { rows: [{ kind, type: "Button", props: {} }] };
      expect(failure("a.json", JSON.stringify(fake))).toBe(`\`kind: "${kind}"\` is reserved; loaded data cannot use it`);
    }
    expect(failure("a.csv", "kind,type\nnode,Card")).toContain("reserved");
    expect(parsed("a.json", '{"kind": "invoice"}')).toEqual({ kind: "invoice" });
  });
});

describe("evaluate with loaded data", () => {
  const SOURCE = `Card("Sales", [
  Table(["Region", "Total"], Load("sales.csv").map(r => [r.region, r.total])),
  Text("Total: " + sum(Load("sales.csv").map(r => r.total)))
])
Text("Footer")`;
  const ok = (path: string, text: string): [string, LoadedData] => [
    dataKey({ path, raw: false }),
    parseDataFile(path, text),
  ];

  it("binds file contents instead of retyped values", () => {
    const data = new Map([ok("sales.csv", "region,total\nEU,120\nUS,80")]);
    const { roots, diagnostics } = evaluate(program(SOURCE), {}, data);
    expect(diagnostics).toEqual([]);
    const [table, total] = children(roots[0]);
    expect(table.props.rows).toEqual([
      ["EU", 120],
      ["US", 80],
    ]);
    expect(total.props.text).toBe("Total: 200");
  });

  it("waits in place, as a loading placeholder and no diagnostic, while the file is being read", () => {
    for (const data of [undefined, new Map<string, LoadedData>()]) {
      const { roots, diagnostics } = evaluate(program(SOURCE), {}, data);
      expect(roots[0].type).toBe("Card");
      const [table, total] = children(roots[0]);
      expect(table).toMatchObject({ type: "Loading", props: { path: "sales.csv", component: "Table" } });
      expect(total).toMatchObject({ type: "Loading", props: { path: "sales.csv", component: "Text" } });
      expect(roots[1]).toMatchObject({ type: "Text", props: { text: "Footer" } });
      expect(diagnostics).toEqual([]);
    }
  });

  it("waits as a whole when a top-level name or bare expression reads the file", () => {
    const { roots, diagnostics } = evaluate(program('rows = Load("todo.json")\nTable(["Task"], rows)\nrows.length'), {});
    expect(roots.map((root) => [root.type, root.props.component])).toEqual([
      ["Loading", "Table"],
      ["Loading", null],
    ]);
    expect(diagnostics).toEqual([]);
  });

  it("reports a failed load inside the component that used it", () => {
    const data = new Map([ok("sales.csv", 'region\n"EU')]);
    const { roots } = evaluate(program(SOURCE), {}, data);
    expect(children(roots[0])[0]).toMatchObject({
      type: "Error",
      props: { message: "Couldn't load sales.csv: a quoted field starting on line 2 never closes" },
    });
    expect(roots[0].type).toBe("Card");
    expect(roots[1].type).toBe("Text");
  });

  it("initializes state from a file", () => {
    const compiled = program('$rows = Load("todo.json")\nChecklist($done, $rows)\n$done = []');
    const data = new Map([ok("todo.json", '["Write", "Test"]')]);
    const state = initialState(compiled, data);
    expect(state).toEqual({ rows: ["Write", "Test"], done: [] });
    expect(evaluate(compiled, state, data).roots[0].props.options).toEqual(["Write", "Test"]);
    expect(initialState(compiled)).toEqual({ rows: null, done: [] });
  });
});

describe("evaluate Snippet", () => {
  const FILE = "one\ntwo\nthree\nfour\nfive\n";

  /** The props of the spec's single Snippet, with `file` (raw text or a failure) loaded for every path it names. */
  function snippet(source: string, file?: string | LoadedData): Record<string, Value> {
    const compiled = program(source);
    const loaded: LoadedData | undefined = typeof file === "string" ? { ok: true, value: file } : file;
    const data = new Map(
      loaded === undefined ? [] : collectLoads(compiled).map((request) => [dataKey(request), loaded] as const),
    );
    const { roots, diagnostics } = evaluate(compiled, {}, data);
    expect(diagnostics).toEqual([]);
    expect(roots[0].type).toBe("Snippet");
    return roots[0].props;
  }

  it("shows lines from..to with the range and the file's language", () => {
    expect(snippet('Snippet("src/app.ts", 2, 4)', FILE)).toEqual({
      path: "src/app.ts",
      from: 2,
      to: 4,
      code: "two\nthree\nfour",
      error: null,
      language: "typescript",
    });
  });

  it("defaults to the whole file and drops the final newline", () => {
    expect(snippet('Snippet("a.py")', FILE)).toMatchObject({ from: null, to: null, code: "one\ntwo\nthree\nfour\nfive" });
    expect(snippet('Snippet("a.py", 4)', "a\r\nb\r\nc\r\nd\r\ne")).toMatchObject({ code: "d\ne" });
    expect(snippet('Snippet("a.py", to: 2)', FILE)).toMatchObject({ code: "one\ntwo" });
  });

  it("clamps `to` to the end of the file", () => {
    expect(snippet('Snippet("a.ts", 4, 99)', FILE)).toMatchObject({ to: 99, code: "four\nfive", error: null });
  });

  it(`shows at most ${MAX_SNIPPET_LINES} lines, cut at from + ${MAX_SNIPPET_LINES - 1}`, () => {
    const big = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n");
    const lines = (snippet('Snippet("big.go", 101)', big).code as string).split("\n");
    expect(lines).toHaveLength(MAX_SNIPPET_LINES);
    expect(lines[0]).toBe("line 101");
    expect(lines.at(-1)).toBe(`line ${100 + MAX_SNIPPET_LINES}`);
  });

  it("is a loading state, not an Error node, while the file is missing", () => {
    expect(snippet('Snippet("src/app.ts", 2, 4)')).toEqual({
      path: "src/app.ts",
      from: 2,
      to: 4,
      code: null,
      error: null,
      language: "typescript",
    });
  });

  it("waits for the raw file even when the same path was loaded parsed", () => {
    const compiled = program('Card("A", [Snippet("a.json"), Text(Load("a.json").name)])');
    const data = new Map([[dataKey({ path: "a.json", raw: false }), parseDataFile("a.json", '{"name": "x"}')]]);
    const [code, text] = children(evaluate(compiled, {}, data).roots[0]);
    expect(code.props).toMatchObject({ code: null, error: null });
    expect(text.props.text).toBe("x");
  });

  it("reports file and range problems as `error`", () => {
    const missing: LoadedData = { ok: false, error: "file not found" };
    expect(snippet('Snippet("a.ts")', missing)).toMatchObject({ code: null, error: "file not found" });
    expect(snippet('Snippet("a.ts", 9)', FILE)).toMatchObject({ code: null, error: "the file has 5 lines; `from` is 9" });
    expect(snippet('Snippet("a.ts")', "")).toMatchObject({ code: null, error: "the file is empty" });
    // Range mistakes show before the file arrives.
    expect(snippet('Snippet("a.ts", 5, 2)')).toMatchObject({ code: null, error: "`from` (5) is after `to` (2)" });
    expect(snippet('Snippet("a.ts", 0)', FILE).error).toBe("`from` must be a line number (1 or more), got 0");
    expect(snippet('Snippet("a.ts", 2, 3.5)', FILE).error).toBe("`to` must be a line number (1 or more), got 3.5");
  });

  it("knows languages by extension or file name", () => {
    expect(snippet('Snippet("Dockerfile")').language).toBe("dockerfile");
    expect(snippet('Snippet("lib/x.RS")').language).toBe("rust");
    expect(snippet('Snippet("notes.unknown")').language).toBeNull();
    expect(snippet('Snippet("LICENSE")').language).toBeNull();
  });
});
