// Vendored from dev.fast review/app/src/review-document-headings.ts @4ecc570 (MIT).
export type ReviewTocLevel = "h2" | "h3";

export interface ReviewTocEntry {
  id: string;
  text: string;
  level: ReviewTocLevel;
}
