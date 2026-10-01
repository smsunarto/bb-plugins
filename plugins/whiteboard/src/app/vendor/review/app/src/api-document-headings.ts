// Vendored from dev.fast review/app/src/api-document-headings.ts @4ecc570 (MIT).
import type { Block } from "../../../../../shared/vendor/review/src/review-api/document.ts";
import { documentHeadings } from "../../../../../shared/vendor/review/src/review-api/document-headings.ts";
import type { ReviewTocEntry } from "./review-document-headings.ts";

/** A snapshot's heading slugs, resolved once for the renderer. */
export interface ApiHeadingIds {
  /** The slug of a section block, or of the nth h2/h3 of a markdown block. */
  get(blockId: string, index?: number): string | undefined;
  entries: ReviewTocEntry[];
}

export function apiHeadingIds(blocks: Block[]): ApiHeadingIds {
  const headings = documentHeadings(blocks);

  const slugs = new Map(
    headings.map((heading) => [
      headingKey(heading.block.id!, heading.index),
      heading.id,
    ]),
  );

  return {
    get: (blockId, index) => slugs.get(headingKey(blockId, index)),
    entries: headings,
  };
}

function headingKey(blockId: string, index?: number): string {
  return index === undefined ? blockId : `${blockId}:${index}`;
}
