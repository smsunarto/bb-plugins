import { createContext } from "react";

/**
 * Writes one markdown block's new markdown to the live session. Null while a past version is
 * displayed, which keeps its blocks read-only.
 */
export type SaveBlockMarkdown = (blockId: string, markdown: string) => Promise<void>;

export const MarkdownEditingContext = createContext<SaveBlockMarkdown | null>(null);
