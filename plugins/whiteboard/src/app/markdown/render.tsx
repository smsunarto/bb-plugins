import type { DOMOutputSpec, Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  type ComponentType,
  type CSSProperties,
  Fragment,
  type ReactNode,
  createElement,
} from "react";
import { HighlightedText } from "../vendor/review/app/src/highlighted-text.tsx";
import { type LinkRenderer, MarkdownLink, scrollToFragment, urlProtocol } from "./link.tsx";
import { type LinkTarget, placeholderIndex } from "./preprocess.ts";

export interface RenderOptions {
  links: LinkTarget[];
  /** Whether an `https:` image may be fetched. Every other image renders nothing. */
  allowRemoteImages: boolean;
  renderLink?: LinkRenderer;
  /** Renders a root h1 instead of the schema's `<h1>`. */
  h1?: ComponentType<{ children?: ReactNode }>;
  /** The id of the document's nth root h2/h3. */
  headingId?: (index: number) => string | undefined;
  highlightQuote?: string;
}

/** A rendered root block. `title` marks a root h1 rendered through `h1`. */
export interface RenderedBlock {
  title: boolean;
  element: ReactNode;
}

interface Context extends RenderOptions {
  /** Upstream highlights quotes in prose only, not in tables or fences. */
  highlight: boolean;
}

/**
 * Static React for a ProseMirror document. Every node and mark renders through its own schema
 * `toDOM`, and adjacent text shares mark elements as ProseMirror's `DOMSerializer` does, so the
 * markup equals a read-only editor's. Exceptions: task items mirror TipTap's node view (what the
 * editor actually shows), and link marks render upstream's link semantics.
 */
export function renderDocument(doc: ProseMirrorNode, options: RenderOptions): RenderedBlock[] {
  const context: Context = { ...options, highlight: options.highlightQuote !== undefined };
  const blocks: RenderedBlock[] = [];
  // Upstream addresses heading ids by ordinal among the root h2/h3 alone.
  let heading = 0;

  doc.forEach((node, _offset, index) => {
    const key = String(index);
    const level = node.type.name === "heading" ? (node.attrs.level as number) : undefined;

    if (level === 1 && options.h1) {
      blocks.push({
        title: true,
        element: createElement(options.h1, { key }, renderContent(node, context)),
      });
    } else if ((level === 2 || level === 3) && options.headingId) {
      blocks.push({
        title: false,
        element: renderNode(node, key, context, { id: options.headingId(heading++) }),
      });
    } else {
      blocks.push({ title: false, element: renderNode(node, key, context) });
    }
  });

  return blocks;
}

function renderNode(
  node: ProseMirrorNode,
  key: string,
  context: Context,
  extra?: Record<string, unknown>,
): ReactNode {
  if (node.isText) return renderText(node.text ?? "", key, context);

  if (node.type.name === "taskItem") return renderTaskItem(node, key, context);

  // `preprocess` applies the image policy to the images upstream's mdast sees. markdown-it can see
  // more (`<div>![x](http://…)</div>` is raw HTML to mdast, a paragraph to markdown-it with
  // `html: false`), so the policy is enforced again here: untrusted text never fetches a URL.
  if (
    node.type.name === "image" &&
    !(context.allowRemoteImages && urlProtocol(String(node.attrs.src ?? "")) === "https:")
  )
    return null;

  const inner =
    node.type.name === "codeBlock" || node.type.name === "table"
      ? { ...context, highlight: false }
      : context;

  const element = fromSpec(node.type.spec.toDOM!(node), renderContent(node, inner), key, extra);
  // Cells keep words whole (document.css), so a table can outgrow its column.
  // It scrolls on its own: the canvas clips sideways overflow.
  return node.type.name === "table" ? (
    <div key={key} className="wb-table-scroll">
      {element}
    </div>
  ) : (
    element
  );
}

/** TipTap `TaskItem`'s node view (`@tiptap/extension-task-item` `addNodeView`). */
function renderTaskItem(node: ProseMirrorNode, key: string, context: Context): ReactNode {
  const checked = node.attrs.checked === true;

  return (
    <li key={key} data-checked={String(checked)}>
      <label>
        <input
          aria-label={`Task item checkbox for ${node.textContent || "empty task item"}`}
          type="checkbox"
          checked={checked}
          // Read-only: React restores `checked` after a click, as the read-only editor does.
          onChange={() => {}}
        />
        <span />
      </label>
      <div>{renderContent(node, context)}</div>
    </li>
  );
}

function renderText(text: string, key: string, context: Context): ReactNode {
  return context.highlight && context.highlightQuote !== undefined ? (
    <HighlightedText key={key} text={text} quote={context.highlightQuote} />
  ) : (
    text
  );
}

/** Children of `parent`, inline content grouped under shared marks (`DOMSerializer.serializeFragment`). */
function renderContent(parent: ProseMirrorNode, context: Context): ReactNode[] {
  if (!parent.inlineContent) {
    const children: ReactNode[] = [];
    parent.forEach((child, _offset, index) =>
      children.push(renderNode(child, String(index), context)),
    );
    return children;
  }

  interface Frame {
    mark?: Mark;
    children: ReactNode[];
  }
  const root: Frame = { children: [] };
  const stack: Frame[] = [root];
  let keys = 0;
  const close = () => {
    const frame = stack.pop()!;
    stack.at(-1)!.children.push(renderMark(frame.mark!, frame.children, `m${keys++}`, context));
  };

  parent.forEach((child, _offset, index) => {
    let keep = 0;
    while (
      keep < stack.length - 1 &&
      keep < child.marks.length &&
      child.marks[keep]!.eq(stack[keep + 1]!.mark!) &&
      child.marks[keep]!.type.spec.spanning !== false
    )
      keep++;
    while (stack.length - 1 > keep) close();
    for (const mark of child.marks.slice(keep)) stack.push({ mark, children: [] });
    stack.at(-1)!.children.push(renderNode(child, String(index), context));
  });
  while (stack.length > 1) close();

  return root.children;
}

function renderMark(mark: Mark, children: ReactNode[], key: string, context: Context): ReactNode {
  if (mark.type.name !== "link") return fromSpec(mark.type.spec.toDOM!(mark, true), children, key);

  const index = placeholderIndex(mark.attrs.href);
  const target = index === undefined ? undefined : context.links[index];

  // Upstream's mdast saw no link here: its text stays text.
  if (!target) return <Fragment key={key}>{children}</Fragment>;

  if (target.kind === "footnote")
    return (
      <sup key={key}>
        <a
          data-footnote-ref=""
          href={`#fn-${target.label}`}
          id={`fnref-${target.label}`}
          onClick={scrollToFragment}
        >
          {target.label}
        </a>
      </sup>
    );

  return (
    <MarkdownLink key={key} href={target.url} title={target.title} renderLink={context.renderLink}>
      {children}
    </MarkdownLink>
  );
}

/** A `DOMOutputSpec` as React, with `hole` in its content slot (`0`). */
function fromSpec(
  spec: DOMOutputSpec,
  hole: ReactNode,
  key?: string,
  extra?: Record<string, unknown>,
): ReactNode {
  if (typeof spec === "string") return spec;

  if (!Array.isArray(spec))
    throw new Error(
      "whiteboard markdown: toDOM returned a DOM node, which static rendering cannot use",
    );

  const [tag, ...rest] = spec as readonly [string, ...unknown[]];
  const attrs = isAttributes(rest[0]) ? (rest.shift() as Record<string, unknown>) : {};
  const children = rest.map((child, index) =>
    child === 0 ? hole : fromSpec(child as DOMOutputSpec, hole, String(index)),
  );

  return createElement(tag, { key, ...reactProps(attrs), ...extra }, ...children);
}

const isAttributes = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !("nodeType" in value);

const REACT_NAMES: Record<string, string> = {
  class: "className",
  colspan: "colSpan",
  rowspan: "rowSpan",
  contenteditable: "contentEditable",
  tabindex: "tabIndex",
  for: "htmlFor",
};

function reactProps(attrs: Record<string, unknown>): Record<string, unknown> {
  const props: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(attrs)) {
    // `DOMSerializer.renderSpec` skips null attributes.
    if (value === null || value === undefined) continue;
    props[REACT_NAMES[name] ?? name] =
      name === "style" ? styleObject(String(value)) : String(value);
  }

  return props;
}

function styleObject(css: string): CSSProperties {
  const style: Record<string, string> = {};

  for (const declaration of css.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim();
    style[
      property.startsWith("--")
        ? property
        : property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    ] = declaration.slice(colon + 1).trim();
  }

  return style;
}
