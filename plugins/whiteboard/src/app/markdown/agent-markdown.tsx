import "@bb-plugins/markdown-prose/prose.css";
import { type ComponentType, type ReactElement, type ReactNode, useMemo } from "react";
import { parseMarkdown } from "../../shared/vendor/review/src/markdown.ts";
import type { LinkRenderer } from "./link.tsx";
import { parse } from "./parser.ts";
import { type Footnote, preprocess } from "./preprocess.ts";
import { type RenderOptions, type RenderedBlock, renderDocument } from "./render.tsx";

export { isReactTextNode } from "./link.tsx";

/**
 * Replaces upstream `agent-markdown.tsx` with the same exports. Markdown parses with the Docs
 * plugin's TipTap schema and renders as static React under `.bb-markdown-prose`, so it reads
 * like a Docs note. Upstream's link, image, footnote and heading-id semantics are kept.
 */
const PROSE = "bb-markdown-prose";

export function AgentMarkdown({
  source,
  className,
  highlightQuote,
}: {
  source: string;
  className?: string;
  highlightQuote?: string;
}): ReactElement {
  const { blocks, footnotes } = useRenderedMarkdown(source, false, { highlightQuote });

  return (
    <div className={["agent-markdown", PROSE, className].filter(Boolean).join(" ")}>
      {blocks.map((block) => block.element)}
      {footnotes}
    </div>
  );
}

/** Reuse safe Markdown parsing in documents without the chat-message wrapper. */
export function MarkdownContent({
  source,
  h1,
  headingId,
  renderLink,
  allowRemoteImages = false,
}: {
  source: string;
  h1?: ComponentType<{ children?: ReactNode }>;
  /** The id of the document's nth h2/h3, undefined where it has none. */
  headingId?: (index: number) => string | undefined;
  renderLink?: LinkRenderer;
  allowRemoteImages?: boolean;
}): ReactElement {
  const { blocks, footnotes } = useRenderedMarkdown(source, allowRemoteImages, {
    h1,
    headingId,
    renderLink,
  });

  // The document title is chrome, not prose: it stays outside the prose wrapper.
  const segments: ReactNode[] = [];
  let run: ReactNode[] = [];
  const flush = () => {
    if (run.length > 0)
      segments.push(
        <div key={`prose-${segments.length}`} className={PROSE}>
          {run}
        </div>,
      );
    run = [];
  };

  for (const block of blocks) {
    if (block.title) {
      flush();
      segments.push(block.element);
    } else {
      run.push(block.element);
    }
  }
  if (footnotes) run.push(footnotes);
  flush();

  return <>{segments}</>;
}

export const markdownHasTitle = (source: string): boolean =>
  (parseMarkdown(source).children ?? []).some(
    (node) => node.type === "heading" && node.depth === 1,
  );

function useRenderedMarkdown(
  source: string,
  allowRemoteImages: boolean,
  options: Omit<RenderOptions, "links" | "allowRemoteImages">,
): { blocks: RenderedBlock[]; footnotes: ReactNode } {
  const prepared = useMemo(
    () => preprocess(source, { allowRemoteImages }),
    [source, allowRemoteImages],
  );
  // ProseMirror pads an empty document with an empty paragraph; upstream renders nothing.
  const blocks = prepared.markdown.trim()
    ? renderDocument(parse(prepared.markdown), {
        ...options,
        allowRemoteImages,
        links: prepared.links,
      })
    : [];

  return {
    blocks,
    footnotes: prepared.footnotes.length > 0 && (
      <Footnotes
        key="footnotes"
        footnotes={prepared.footnotes}
        allowRemoteImages={allowRemoteImages}
        renderLink={options.renderLink}
        highlightQuote={options.highlightQuote}
      />
    ),
  };
}

/** GFM footnote definitions render once, after the body, in source order (upstream markup). */
function Footnotes({
  footnotes,
  allowRemoteImages,
  renderLink,
  highlightQuote,
}: {
  footnotes: Footnote[];
  allowRemoteImages: boolean;
  renderLink?: LinkRenderer;
  highlightQuote?: string;
}): ReactNode {
  return (
    <section data-footnotes="" className="footnotes">
      <ol>
        {footnotes.map((footnote, index) => (
          // A label can repeat (upstream renders every definition), so the index is the key.
          // oxlint-disable-next-line react/no-array-index-key
          <li key={index} id={`fn-${footnote.label}`}>
            <FootnoteBody
              markdown={footnote.markdown}
              allowRemoteImages={allowRemoteImages}
              renderLink={renderLink}
              highlightQuote={highlightQuote}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function FootnoteBody({
  markdown,
  allowRemoteImages,
  renderLink,
  highlightQuote,
}: {
  markdown: string;
  allowRemoteImages: boolean;
  renderLink?: LinkRenderer;
  highlightQuote?: string;
}): ReactNode {
  const { blocks } = useRenderedMarkdown(markdown, allowRemoteImages, {
    renderLink,
    highlightQuote,
  });

  return blocks.map((block) => block.element);
}
