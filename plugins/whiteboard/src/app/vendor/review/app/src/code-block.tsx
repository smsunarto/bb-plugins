// Vendored from dev.fast review/app/src/code-block.tsx @4ecc570 (MIT).
import { type ComponentProps, type ReactElement } from "react";

import { useHighlightedCode } from "../../../../lib/highlight.tsx";

import { CopyButton } from "./copy-text.tsx";
import { DiagramHeader } from "./diagram-header.tsx";

export interface RenderedCodeBlockProps extends ComponentProps<"pre"> {
  code: string;
  language?: string | null;
  /** Header title; a fenced markdown block has none. */
  caption?: string;
  /** Ghost line numbers in a sticky gutter; off for fenced markdown. */
  lineNumbers?: boolean;
  codeClassName?: string;
  codeAttributes?: Record<string, string>;
}

/** A code figure: the same header as the other figures (language badge,
 * caption, line count, copy), then the highlighted code. */
export function RenderedCodeBlock({
  code,
  language,
  caption,
  lineNumbers = false,
  codeClassName,
  codeAttributes,
  className,
  ...props
}: RenderedCodeBlockProps): ReactElement {
  const highlighted = useHighlightedCode(code, language);

  const figureClassName = ["rendered-code-block", className]
    .filter(Boolean)
    .join(" ");

  const displayLanguage = language?.trim() || undefined;
  const lineCount = countLines(code);

  return (
    <figure
      className={figureClassName}
      data-language={displayLanguage}
      data-code-theme={highlighted.style ? "" : undefined}
      style={highlighted.style}
    >
      <DiagramHeader
        kind={displayLanguage || "code"}
        title={caption}
        meta={`${lineCount} ${lineCount === 1 ? "line" : "lines"}`}
        action={
          <CopyButton text={code} label="Copy" className="rendered-code-copy" />
        }
      />
      <pre {...props} className="rendered-code-body">
        {lineNumbers && (
          <span aria-hidden="true" className="rendered-code-gutter">
            {Array.from({ length: lineCount }, (_, index) => index + 1).join(
              "\n",
            )}
          </span>
        )}
        <code
          {...codeAttributes}
          className={codeClassName}
          data-review-copy-prose
        >
          {highlighted.content}
        </code>
      </pre>
    </figure>
  );
}

/** A trailing newline ends the last line rather than starting an empty one. */
function countLines(code: string): number {
  const lines = code.split("\n");

  return lines.length > 1 && lines.at(-1) === ""
    ? lines.length - 1
    : lines.length;
}
