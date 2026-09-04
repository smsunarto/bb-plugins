import type { Program } from "estree";
import type { Code, Node, Root, RootContent, Yaml } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type {
  CanvasDocument,
  CanvasNode,
  Diagnostic,
  JsonValue,
  Span,
} from "../shared/document.ts";
import { collectStateIds } from "../shared/document.ts";
import {
  isComponentName,
  isStateful,
  specOf,
  suggestComponentName,
  type ChildPolicy,
  type ComponentName,
} from "../shared/registry.ts";
import { defaultStyle, isStyleName, suggestStyleName, type StyleName } from "../shared/styles.ts";
import { foldLiteral } from "./literal.ts";

export type ParseResult =
  | { readonly ok: true; readonly document: CanvasDocument }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

type JsxFlowElement = Extract<RootContent, { type: "mdxJsxFlowElement" }>;
type JsxAttribute = JsxFlowElement["attributes"][number];

const processor = unified().use(remarkParse).use(remarkFrontmatter).use(remarkMdx);

export const maxCanvasBytes = 2 * 1024 * 1024;

const importMessage = "imports are not allowed; every component is ambient";

class LineIndex {
  private readonly starts: number[] = [0];
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
    for (let i = 0; i < source.length; i += 1) {
      if (source.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
  }

  at(offset: number): { line: number; column: number } {
    const clamped = Math.max(0, Math.min(offset, this.source.length));
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= clamped) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: clamped - (this.starts[low] ?? 0) + 1 };
  }

  offsetOf(line: number, column: number): number {
    const start = this.starts[Math.max(0, line - 1)] ?? 0;
    return start + Math.max(0, column - 1);
  }
}

class Walker {
  private readonly source: string;
  private readonly lines: LineIndex;
  private readonly seenStateIds = new Map<string, Span>();

  constructor(source: string) {
    this.source = source;
    this.lines = new LineIndex(source);
  }

  spanOf(node: Node): Span {
    const position = node.position;
    if (position === undefined) return { line: 1, column: 1, startOffset: 0, endOffset: 0 };
    const startOffset =
      position.start.offset ?? this.lines.offsetOf(position.start.line, position.start.column);
    const endOffset =
      position.end.offset ?? this.lines.offsetOf(position.end.line, position.end.column);
    return { line: position.start.line, column: position.start.column, startOffset, endOffset };
  }

  spanAt(offset: number, endOffset = offset): Span {
    const { line, column } = this.lines.at(offset);
    return { line, column, startOffset: offset, endOffset: Math.max(offset, endOffset) };
  }

  // remark-frontmatter only emits `yaml` for a block at the very top of the
  // file, so the root walk peels it here and `blocks` never sees one.
  document(children: readonly RootContent[]): { style: StyleName; nodes: CanvasNode[] } {
    const [first, ...rest] = children;
    if (first === undefined || first.type !== "yaml") {
      return { style: defaultStyle, nodes: this.blocks(children) };
    }
    const frontmatter = this.frontmatter(first);
    return { style: frontmatter.style, nodes: [...frontmatter.problems, ...this.blocks(rest)] };
  }

  private frontmatter(node: Yaml): { style: StyleName; problems: CanvasNode[] } {
    const span = this.spanOf(node);
    const problems: CanvasNode[] = [];
    const seen = new Set<string>();
    let style: StyleName = defaultStyle;
    const lines = node.value.split("\n");
    for (const [index, raw] of lines.entries()) {
      const line = raw.trim();
      if (line.length === 0) continue;
      const lineNumber = span.line + 1 + index;
      const match = frontmatterLine.exec(line);
      if (match === null) {
        problems.push(
          diagnosticNode(
            "invalid-frontmatter",
            `invalid frontmatter at line ${lineNumber}: expected \`key: value\`, got \`${line}\``,
            span,
          ),
        );
        continue;
      }
      const key = match[1] ?? "";
      const value = match[2] ?? "";
      if (key !== "style") {
        problems.push(
          diagnosticNode(
            "unknown-frontmatter-key",
            `unknown frontmatter key \`${key}\`; only \`style\` is allowed`,
            span,
          ),
        );
        continue;
      }
      if (seen.has(key)) {
        problems.push(
          diagnosticNode(
            "invalid-frontmatter",
            `invalid frontmatter at line ${lineNumber}: \`${key}\` is already set`,
            span,
          ),
        );
        continue;
      }
      seen.add(key);
      if (isStyleName(value)) {
        style = value;
        continue;
      }
      const didYouMean = suggestStyleName(value);
      const hint = didYouMean === undefined ? "" : `; did you mean \`${didYouMean}\`?`;
      problems.push({
        kind: "diagnostic",
        diagnostic: {
          code: "unknown-style",
          message: `unknown style \`${value}\`${hint}`,
          span,
          ...(didYouMean === undefined ? {} : { didYouMean }),
        },
      });
    }
    return { style, problems };
  }

  blocks(children: readonly RootContent[], only?: readonly string[]): CanvasNode[] {
    const out: CanvasNode[] = [];
    let run: RootContent[] = [];
    const flush = (): void => {
      const first = run[0];
      const last = run[run.length - 1];
      if (first === undefined || last === undefined) return;
      const startOffset = this.spanOf(first).startOffset;
      const endOffset = this.spanOf(last).endOffset;
      const slice = this.source.slice(startOffset, endOffset);
      if (only !== undefined) {
        out.push(
          diagnosticNode(
            "disallowed-child",
            `only ${only.join(", ")} may appear here`,
            this.spanOf(first),
          ),
        );
      } else {
        for (const node of run) out.push(...this.embeddedDiagnostics(node));
        out.push({ kind: "markdown", source: slice, span: { ...this.spanOf(first), endOffset } });
      }
      run = [];
    };
    for (const child of children) {
      switch (child.type) {
        case "mdxjsEsm":
          flush();
          out.push(diagnosticNode("import-not-allowed", importMessage, this.spanOf(child)));
          break;
        case "mdxFlowExpression":
          flush();
          out.push(
            diagnosticNode(
              "expression-not-allowed",
              "expressions are not allowed outside component props; write markdown or a component",
              this.spanOf(child),
            ),
          );
          break;
        case "mdxJsxFlowElement":
          flush();
          out.push(...this.element(child, only));
          break;
        // A definition glues onto the block before it so reference links in
        // that block keep resolving once the host renders each block alone.
        case "definition":
        case "footnoteDefinition":
          run.push(child);
          break;
        default:
          flush();
          run.push(child);
      }
    }
    flush();
    return out;
  }

  private embeddedDiagnostics(node: Node): CanvasNode[] {
    const out: CanvasNode[] = [];
    const visit = (current: Node): void => {
      switch (current.type) {
        case "mdxJsxTextElement":
        case "mdxJsxFlowElement":
          out.push(
            diagnosticNode(
              "inline-component",
              "components must sit alone at the block level, not inside text, lists, or quotes",
              this.spanOf(current),
            ),
          );
          return;
        case "mdxTextExpression":
        case "mdxFlowExpression":
          out.push(
            diagnosticNode(
              "expression-not-allowed",
              "expressions are not allowed inside markdown; write the value as text",
              this.spanOf(current),
            ),
          );
          return;
        case "mdxjsEsm":
          out.push(diagnosticNode("import-not-allowed", importMessage, this.spanOf(current)));
          return;
        default:
          break;
      }
      const children = (current as { children?: Node[] }).children;
      if (children !== undefined) for (const child of children) visit(child);
    };
    visit(node);
    return out;
  }

  private element(element: JsxFlowElement, only?: readonly string[]): CanvasNode[] {
    const span = this.spanOf(element);
    const name = element.name;
    if (name === null) {
      return [
        diagnosticNode(
          "fragment-not-allowed",
          "fragments are not allowed; use a named component",
          span,
        ),
      ];
    }
    if (only !== undefined && !only.includes(name)) {
      return [
        diagnosticNode(
          "disallowed-child",
          `\`${name}\` may not appear here; only ${only.join(", ")} may`,
          span,
        ),
      ];
    }
    if (!isComponentName(name)) {
      const didYouMean = suggestComponentName(name);
      const hint = didYouMean === undefined ? "" : `; did you mean \`${didYouMean}\`?`;
      const diagnostic: Diagnostic = {
        code: "unknown-component",
        message: `unknown component \`${name}\`${hint}`,
        span,
        ...(didYouMean === undefined ? {} : { didYouMean }),
      };
      return [{ kind: "diagnostic", diagnostic }];
    }
    const spec = specOf(name);
    const problems: CanvasNode[] = [];
    const props: Record<string, JsonValue> = {};
    const dropped = new Set<string>();
    for (const attribute of element.attributes) {
      const folded = this.attribute(attribute);
      if (folded.ok) {
        props[folded.name] = folded.value;
      } else {
        if (folded.name !== undefined) dropped.add(folded.name);
        problems.push(diagnosticNode("non-literal-prop", folded.message, folded.span));
      }
    }
    const children = this.children(name, spec.children, element, props, problems);
    const validation = spec.props.safeParse(props);
    if (!validation.success) {
      for (const issue of validation.error.issues) {
        const head = issue.path[0];
        if (typeof head === "string" && dropped.has(head)) continue;
        const path = issue.path.map(String).join(".");
        const label = path.length === 0 ? "props" : `\`${path}\``;
        problems.push(diagnosticNode("invalid-prop", `${label}: ${issue.message}`, span));
      }
    }
    if (
      problems.some(
        (node) => node.kind === "diagnostic" && node.diagnostic.code !== "unexpected-children",
      )
    ) {
      return problems;
    }
    const validProps = (validation.success ? validation.data : props) as Record<string, JsonValue>;
    if (isStateful(name)) {
      const id = validProps["id"];
      if (typeof id === "string") {
        const previous = this.seenStateIds.get(id);
        if (previous !== undefined) {
          return [
            ...problems,
            diagnosticNode(
              "duplicate-state-id",
              `state id \`${id}\` is already used at ${previous.line}:${previous.column}; ids must be unique per canvas`,
              span,
            ),
          ];
        }
        this.seenStateIds.set(id, span);
      }
    }
    return [...problems, { kind: "component", name, props: validProps, children, span }];
  }

  private children(
    name: ComponentName,
    policy: ChildPolicy,
    element: JsxFlowElement,
    props: Record<string, JsonValue>,
    problems: CanvasNode[],
  ): CanvasNode[] {
    const nested = element.children as readonly RootContent[];
    switch (policy.kind) {
      case "none": {
        const first = nested[0];
        if (first !== undefined) {
          problems.push(
            diagnosticNode(
              "unexpected-children",
              `\`${name}\` takes no children; everything it shows comes from props`,
              this.spanOf(first),
            ),
          );
        }
        return [];
      }
      case "blocks":
        return this.blocks(nested, policy.only);
      case "code": {
        const code =
          nested.length === 1 && nested[0]?.type === "code" ? (nested[0] as Code) : undefined;
        if (code !== undefined) {
          props[policy.prop] = code.value;
          if (policy.langProp !== undefined && code.lang !== null && code.lang !== undefined) {
            props[policy.langProp] ??= code.lang;
          }
        } else if (typeof props[policy.prop] !== "string") {
          props[policy.prop] = "";
          problems.push(
            diagnosticNode(
              "expected-code-child",
              `\`${name}\` expects exactly one fenced code block as its child`,
              nested[0] === undefined ? this.spanOf(element) : this.spanOf(nested[0]),
            ),
          );
        }
        return [];
      }
    }
  }

  private attribute(
    attribute: JsxAttribute,
  ):
    | { ok: true; name: string; value: JsonValue }
    | { ok: false; name?: string; message: string; span: Span } {
    if (attribute.type === "mdxJsxExpressionAttribute") {
      return {
        ok: false,
        message: "a spread is not a value a canvas can hold; list each prop explicitly",
        span: this.spanOf(attribute),
      };
    }
    const name = attribute.name;
    const value = attribute.value;
    if (value === null || value === undefined) return { ok: true, name, value: true };
    if (typeof value === "string") return { ok: true, name, value };
    const program = value.data?.estree as Program | null | undefined;
    if (program === null || program === undefined) {
      return {
        ok: false,
        name,
        message: `\`${name}\` holds an expression the parser could not read`,
        span: this.spanOf(attribute),
      };
    }
    const folded = foldLiteral(program);
    if (folded.ok) return { ok: true, name, value: folded.value };
    const attributeSpan = this.spanOf(attribute);
    const offset = folded.offset > 0 ? folded.offset : attributeSpan.startOffset;
    return {
      ok: false,
      name,
      message: `\`${name}\`: ${folded.reason}`,
      span: this.spanAt(offset, attributeSpan.endOffset),
    };
  }

  syntaxError(error: unknown): Diagnostic {
    const failure = (typeof error === "object" && error !== null ? error : {}) as {
      line?: number | null;
      column?: number | null;
      reason?: string;
      message?: string;
      place?: {
        line?: number;
        column?: number;
        offset?: number;
        start?: { line: number; column: number; offset?: number };
      };
    };
    const reason = failure.reason ?? failure.message ?? String(error);
    let line = failure.line ?? undefined;
    let column = failure.column ?? undefined;
    let offset: number | undefined;
    const place = failure.place;
    if (place !== undefined) {
      const point = place.start ?? place;
      line ??= point.line;
      column ??= point.column;
      offset = point.offset;
    }
    if (line === undefined || column === undefined) {
      const match = /\((\d+):(\d+)-/.exec(reason);
      if (match !== null) {
        line = Number(match[1]);
        column = Number(match[2]);
      }
    }
    if (line === undefined || column === undefined) {
      return { code: "syntax-error", message: reason, span: null };
    }
    const startOffset = offset ?? this.lines.offsetOf(line, column);
    return {
      code: "syntax-error",
      message: reason,
      span: { line, column, startOffset, endOffset: startOffset },
    };
  }
}

const frontmatterLine = /^([A-Za-z_][A-Za-z0-9_]*):\s+(\S.*)$/;

function diagnosticNode(code: Diagnostic["code"], message: string, span: Span): CanvasNode {
  return { kind: "diagnostic", diagnostic: { code, message, span } };
}

export function parseCanvas(source: string): ParseResult {
  const walker = new Walker(source);
  let root: Root;
  try {
    root = processor.parse(source);
  } catch (error) {
    return { ok: false, diagnostic: walker.syntaxError(error) };
  }
  const { style, nodes } = walker.document(root.children);
  const stateIds = [...new Set(collectStateIds(nodes))];
  return { ok: true, document: { style, nodes, stateIds } };
}

export interface DocumentStats {
  readonly style: StyleName;
  readonly blocks: number;
  readonly components: readonly string[];
  readonly stateIds: readonly string[];
}

export function documentStats(document: CanvasDocument): DocumentStats {
  const components: string[] = [];
  const walk = (nodes: readonly CanvasNode[]): void => {
    for (const node of nodes) {
      if (node.kind !== "component") continue;
      if (!components.includes(node.name)) components.push(node.name);
      walk(node.children);
    }
  };
  walk(document.nodes);
  return {
    style: document.style,
    blocks: document.nodes.length,
    components,
    stateIds: document.stateIds,
  };
}
