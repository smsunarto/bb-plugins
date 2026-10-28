// What a ```app document that is still streaming can show: the static markup
// written so far, for the preview frame (ui/AppBlock.tsx) to draw while the
// reply writes the rest. Nothing here runs: scripts are dropped, and the
// preview only ever sees markup and complete stylesheets.

export interface PartialHtml {
  /** The text of every complete `<style>` block, wherever it stands. */
  readonly css: string;
  /** The markup of the document's body (the whole fragment when it has no `<body>`). */
  readonly body: string;
}

const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

/**
 * The partial document `html` as markup that parses the same now as it will
 * once complete: an unfinished tag or entity at the end is cut (it would
 * show as text), scripts (finished or not) and comments go, and an
 * unfinished `<style>` takes everything after it, since all of that is CSS.
 */
export function processPartialHtml(html: string): PartialHtml {
  let rest = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*$/i, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!--[\s\S]*$/, "");
  const css: string[] = [];
  rest = rest.replace(STYLE_BLOCK, (_block, text: string) => {
    css.push(text);
    return "";
  });
  rest = rest
    .replace(/<style\b[^>]*>[\s\S]*$/i, "")
    .replace(/<[^>]*$/, "")
    .replace(/&[a-zA-Z0-9#]*$/, "");

  const open = /<body\b[^>]*>/i.exec(rest);
  if (open !== null) {
    rest = rest.slice(open.index + open[0].length).replace(/<\/body\s*>[\s\S]*$/i, "");
  } else {
    // No body yet: what stands outside the head is the content (a fragment written without one).
    rest = rest
      .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, "")
      .replace(/<head\b[^>]*>[\s\S]*$/i, "")
      .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, "")
      .replace(/<title\b[^>]*>[\s\S]*$/i, "")
      .replace(/<!doctype[^>]*>|<\/?html\b[^>]*>|<meta\b[^>]*>|<link\b[^>]*>/gi, "");
  }
  return { css: css.join("\n"), body: rest.replace(/<\/html\s*>[\s\S]*$/i, "") };
}
