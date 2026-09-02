import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { collectDiagnostics, type CanvasNode } from "../shared/document.ts";
import { documentStats, parseCanvas } from "./parse.ts";

const sample = readFileSync(
  new URL("../examples/flaky-test-triage.canvas.mdx", import.meta.url),
  "utf8",
);

function parsed(source: string) {
  const result = parseCanvas(source);
  assert.equal(result.ok, true, "expected a parsed document");
  if (!result.ok) throw new Error("unreachable");
  return result.document;
}

function labelOf(node: CanvasNode): string {
  if (node.kind === "component") return node.name;
  if (node.kind === "diagnostic") return `!${node.diagnostic.code}`;
  return "markdown";
}

test("the sample canvas parses to the expected node kinds in order", () => {
  const document = parsed(sample);
  assert.deepEqual(document.nodes.map(labelOf), [
    "markdown",
    "Row",
    "Callout",
    "BarChart",
    "Table",
    "markdown",
    "FileLink",
    "Card",
  ]);
  assert.deepEqual(collectDiagnostics(document), []);
  assert.deepEqual(document.stateIds, ["show-patch"]);
  const row = document.nodes[1];
  assert.equal(row?.kind, "component");
  if (row?.kind === "component") {
    assert.deepEqual(row.props, { gap: "md" });
    assert.deepEqual(row.children.map(labelOf), ["Stat", "Stat", "Stat"]);
  }
  const stats = documentStats(document);
  assert.equal(stats.blocks, 8);
  assert.deepEqual(stats.components, [
    "Row",
    "Stat",
    "Callout",
    "BarChart",
    "Table",
    "FileLink",
    "Card",
    "Toggle",
    "DiffView",
  ]);
});

test("markdown slices are verbatim source", () => {
  const document = parsed(sample);
  const first = document.nodes[0];
  assert.equal(first?.kind, "markdown");
  if (first?.kind === "markdown") {
    assert.equal(first.source, sample.slice(first.span.startOffset, first.span.endOffset));
    assert.ok(first.source.startsWith("# Flaky test triage for bb-plugins CI"));
    assert.ok(first.source.endsWith("touch the shared dev-instance port."));
    assert.equal(first.span.line, 1);
    assert.equal(first.span.column, 1);
  }
  const callout = document.nodes[2];
  assert.equal(callout?.kind, "component");
  if (callout?.kind === "component") {
    const body = callout.children[0];
    assert.equal(body?.kind, "markdown");
    if (body?.kind === "markdown") {
      assert.ok(body.source.startsWith("Every top offender calls `dev:setup`"));
      assert.equal(body.source, sample.slice(body.span.startOffset, body.span.endOffset));
    }
  }
});

test("fenced code children feed the code prop and language", () => {
  const document = parsed(sample);
  const card = document.nodes[7];
  assert.equal(card?.kind, "component");
  if (card?.kind !== "component") return;
  const toggle = card.children[0];
  assert.equal(toggle?.kind, "component");
  if (toggle?.kind !== "component") return;
  assert.deepEqual(toggle.props, {
    id: "show-patch",
    label: "Show the proposed patch",
    default: true,
  });
  const diff = toggle.children[0];
  assert.equal(diff?.kind, "component");
  if (diff?.kind !== "component") return;
  assert.equal(diff.name, "DiffView");
  assert.equal(diff.props["path"], "scripts/bb-dev-cli");
  assert.ok(String(diff.props["patch"]).startsWith("@@ -84,7 +84,9 @@"));
  const source = parsed('<Source path="a.ts">\n```ts\nconst a = 1;\n```\n</Source>\n');
  const node = source.nodes[0];
  assert.equal(node?.kind, "component");
  if (node?.kind === "component") {
    assert.deepEqual(node.props, { path: "a.ts", language: "ts", content: "const a = 1;" });
  }
});

test("unknown component reports a suggestion and keeps the rest of the document", () => {
  const document = parsed(
    '# Title\n\n<Tabel headers={["a"]} rows={[]} />\n\n<Pill label="ok" />\n',
  );
  assert.deepEqual(document.nodes.map(labelOf), ["markdown", "!unknown-component", "Pill"]);
  const [diagnostic] = collectDiagnostics(document);
  assert.equal(diagnostic?.didYouMean, "Table");
  assert.equal(diagnostic?.message, "unknown component `Tabel`; did you mean `Table`?");
  assert.equal(diagnostic?.span?.line, 3);
  assert.equal(diagnostic?.span?.column, 1);
});

test("non-literal expressions name the construct and point at it", () => {
  const document = parsed('<Stat label="x" value={compute(1)} />\n');
  const [diagnostic] = collectDiagnostics(document);
  assert.equal(diagnostic?.code, "non-literal-prop");
  assert.match(
    diagnostic?.message ?? "",
    /`value`: a function call is not a value a canvas can hold/,
  );
  assert.equal(diagnostic?.span?.line, 1);
  assert.equal(diagnostic?.span?.column, 24);
  const arrow = parsed('<Stat label="x" value={() => 1} />\n');
  assert.match(collectDiagnostics(arrow)[0]?.message ?? "", /a function/);
  const spread = parsed("<Stat {...props} />\n");
  assert.match(collectDiagnostics(spread)[0]?.message ?? "", /spread/);
});

test("invalid props report the zod path and message", () => {
  const document = parsed('<Table headers={["a"]} rows="nope" />\n');
  const diagnostics = collectDiagnostics(document);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "invalid-prop");
  assert.match(diagnostics[0]?.message ?? "", /^`rows`: /);
  const missing = parsed("<Stat />\n");
  const paths = collectDiagnostics(missing).map((d) => d.message.split(":")[0]);
  assert.deepEqual(paths, ["`label`", "`value`"]);
});

test("inline JSX inside a paragraph, list, or quote is a diagnostic", () => {
  const document = parsed(
    'Some text with <Pill label="x" /> inside.\n\n- item <Pill label="y" />\n\n> <Pill label="z" />\n',
  );
  const codes = collectDiagnostics(document).map((d) => d.code);
  assert.deepEqual(codes, ["inline-component", "inline-component", "inline-component"]);
  const markdown = document.nodes.filter((node) => node.kind === "markdown");
  assert.equal(markdown.length, 1);
});

test("duplicate state ids are diagnostics and appear once in stateIds", () => {
  const document = parsed(
    '<Toggle id="a" label="one" />\n\n<Select id="a" label="two" options={["x"]} />\n\n<Toggle id="b" label="three" />\n',
  );
  assert.deepEqual(document.nodes.map(labelOf), ["Toggle", "!duplicate-state-id", "Toggle"]);
  const [diagnostic] = collectDiagnostics(document);
  assert.match(diagnostic?.message ?? "", /already used at 1:1/);
  assert.deepEqual(document.stateIds, ["a", "b"]);
});

test("import and export statements are rejected with the ambient message", () => {
  const document = parsed('import { Table } from "./x";\n\n# hi\n\nexport const a = 1;\n');
  const diagnostics = collectDiagnostics(document);
  assert.equal(diagnostics.length, 2);
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.code, "import-not-allowed");
    assert.equal(diagnostic.message, "imports are not allowed; every component is ambient");
  }
  assert.equal(diagnostics[0]?.span?.line, 1);
  assert.equal(diagnostics[1]?.span?.line, 5);
});

test("bare expressions are diagnostics", () => {
  const document = parsed("# hi\n\n{1 + 1}\n\nA {name} in text.\n");
  const codes = collectDiagnostics(document).map((d) => d.code);
  assert.deepEqual(codes, ["expression-not-allowed", "expression-not-allowed"]);
});

test("a hard syntax error yields one positioned diagnostic and no document", () => {
  const unclosed = parseCanvas('# hi\n\n<Card title="x">\n\ntext\n');
  assert.equal(unclosed.ok, false);
  if (!unclosed.ok) {
    assert.equal(unclosed.diagnostic.code, "syntax-error");
    assert.equal(unclosed.diagnostic.span?.line, 3);
    assert.equal(unclosed.diagnostic.span?.column, 1);
  }
  const mismatched = parseCanvas("<Card>\n\ntext\n\n</Section>\n");
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) {
    assert.equal(mismatched.diagnostic.code, "syntax-error");
    assert.ok(mismatched.diagnostic.span !== null);
  }
  const empty = parseCanvas('<Stat label="x" value={} />\n');
  assert.equal(empty.ok, false);
});

test("child policies are enforced", () => {
  const none = parsed('<Stat label="x" value={1}>\n\nbody\n\n</Stat>\n');
  assert.deepEqual(none.nodes.map(labelOf), ["!unexpected-children", "Stat"]);
  const tabs = parsed(
    '<Tabs id="t">\n\ntext\n\n<Tab label="a">\n\nhello\n\n</Tab>\n\n<Pill label="p" />\n\n</Tabs>\n',
  );
  const node = tabs.nodes[0];
  assert.equal(node?.kind, "component");
  if (node?.kind === "component") {
    assert.deepEqual(node.children.map(labelOf), ["!disallowed-child", "Tab", "!disallowed-child"]);
  }
  const noCode = parsed('<DiffView path="a" />\n');
  assert.deepEqual(noCode.nodes.map(labelOf), ["!expected-code-child"]);
  const fragment = parsed("<>\n\nhi\n\n</>\n");
  assert.deepEqual(fragment.nodes.map(labelOf), ["!fragment-not-allowed"]);
});

test("literal grammar covers negatives, templates, and bare booleans", () => {
  const document = parsed(
    '<Stat label="x" value={-3} caption={`plain`} />\n\n<Toggle id="t" label="l" default />\n',
  );
  const [stat, toggle] = document.nodes;
  assert.equal(stat?.kind, "component");
  if (stat?.kind === "component")
    assert.deepEqual(stat.props, { label: "x", value: -3, caption: "plain" });
  assert.equal(toggle?.kind, "component");
  if (toggle?.kind === "component") assert.equal(toggle.props["default"], true);
});
