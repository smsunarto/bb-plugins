import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** Resolve local destinations without touching code, prose, or remote links. */
export function previewMarkdown(content: string, previewUrl: string): string {
  const documentUrl = new URL(previewUrl, window.location.href);
  const tree = fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  function visit(node: { url?: string; children?: readonly unknown[] }) {
    if (node.url && !/^[a-z][a-z\d+.-]*:|^[/#]/iu.test(node.url)) {
      const url = new URL(node.url, documentUrl);
      const directory = new URL("./", documentUrl);
      // A destination outside the lease must not hide the rest of the document.
      // Leave unsupported links as authored; the file API still confines reads.
      if (url.pathname.startsWith(directory.pathname)) node.url = url.href;
    }
    for (const child of node.children ?? []) visit(child as Parameters<typeof visit>[0]);
  }
  visit(tree);
  return toMarkdown(tree, { extensions: [gfmToMarkdown()] });
}
