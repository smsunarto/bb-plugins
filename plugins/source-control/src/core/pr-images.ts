/**
 * Images in a pull request's text that GitHub serves only to someone signed
 * in when the repository is private: uploaded attachments and files committed
 * to the repository. The page cannot sign in, so it asks the plugin's server
 * for each of them; the server answers with the original URL when GitHub
 * serves it to anyone, and otherwise with the short-lived URL GitHub gives a
 * signed-in reader. Other images keep their own URL.
 */
import type { Repo } from "./ids.ts";

/** The plugin HTTP route the page points such an image at. */
export const PR_IMAGE_PATH = "/pr-image";

/** The longest image URL the route takes. */
export const MAX_IMAGE_URL = 2_048;
/** The longest signed URL a site may answer with. */
export const MAX_SIGNED_URL = 8_192;

export type GitHubImage =
  /** An upload: `github.com/user-attachments/assets/<id>` or `github.com/<owner>/<repo>/assets/<n>/<id>`. */
  | { kind: "attachment"; url: string; id: string }
  /**
   * A committed file: `github.com/<owner>/<repo>/(blob|raw)/<ref>/<path>` or
   * `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`. `segments` is the
   * ref and the path together: a branch name may hold slashes, so where one
   * ends is found by asking GitHub (`refSplits`).
   */
  | { kind: "file"; url: string; repo: Repo; segments: string[] };

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9_.-]+$/;

/** An image file's name: only these are asked of GitHub, so the route never hands out other files. */
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?|heic)$/i;

/**
 * The path's segments, decoded, or null when one is unreadable or, once
 * decoded, holds a separator or is `.`/`..`: an encoded `%2F..%2F` would
 * otherwise climb out of the repository when the path is joined again.
 */
function decoded(segments: readonly string[]): string[] | null {
  try {
    const parts = segments.map((segment) => decodeURIComponent(segment));
    const unsafe = parts.some(
      (part) => part === "." || part === ".." || part.includes("/") || part.includes("\\"),
    );
    return unsafe ? null : parts;
  } catch {
    return null;
  }
}

/**
 * The GitHub image a URL names, or null for any other URL, including a
 * committed file whose name is not an image's.
 */
export function parseGitHubImage(src: string): GitHubImage | null {
  const url = httpsUrl(src);
  const segments = url ? decoded(url.pathname.split("/").filter(Boolean)) : null;
  if (!url || !segments) return null;
  if (url.hostname === "github.com") return onGitHub(url, segments);
  if (url.hostname === "raw.githubusercontent.com") {
    const [owner = "", name = "", ...rest] = segments;
    return repoNamed(owner, name) ? file(url.href, owner, name, rest) : null;
  }
  return null;
}

/** `src` as a plain https URL: no credentials, no port. */
function httpsUrl(src: string): URL | null {
  // The URL parser reads "\\" as "/": a backslash left in a source names another path.
  if (src.length > MAX_IMAGE_URL || src.includes("\\")) return null;
  try {
    const url = new URL(src.trim());
    const plain = url.protocol === "https:" && !url.username && !url.password && !url.port;
    return plain ? url : null;
  } catch {
    return null;
  }
}

const repoNamed = (owner: string, name: string) => NAME.test(owner) && NAME.test(name);
const assetId = (id: string | undefined) => id !== undefined && ASSET_ID.test(id);

function onGitHub(url: URL, segments: readonly string[]): GitHubImage | null {
  const [first = "", second = "", third, fourth = "", fifth, ...rest] = segments;
  const upload = (id: string | undefined) => ({
    kind: "attachment" as const,
    url: url.href,
    id: (id ?? "").toLowerCase(),
  });
  if (first === "user-attachments" && second === "assets")
    return segments.length === 3 && assetId(third) ? upload(third) : null;
  if (!repoNamed(first, second)) return null;
  if (third === "assets")
    return /^\d+$/.test(fourth) && assetId(fifth) && rest.length === 0 ? upload(fifth) : null;
  const committed =
    third === "raw" ||
    (third === "blob" && ["true", "1"].includes(url.searchParams.get("raw") ?? ""));
  return committed && fourth && fifth
    ? file(url.href, first, second, [fourth, fifth, ...rest])
    : null;
}

function file(
  url: string,
  owner: string,
  name: string,
  segments: readonly string[],
): GitHubImage | null {
  // A ref and at least one path segment, ending in an image file's name.
  if (segments.length < 2 || !IMAGE_FILE.test(segments.at(-1) ?? "")) return null;
  return {
    kind: "file",
    url,
    repo: { owner: owner.toLowerCase(), name: name.toLowerCase() },
    segments: [...segments],
  };
}

/** One image however its URL is spelled: query, fragment and case aside. */
export function imageIdentity(image: GitHubImage): string {
  return image.kind === "attachment"
    ? `upload:${image.id}`
    : `file:${image.repo.owner}/${image.repo.name}:${image.segments.join("/")}`;
}

/** At most this many ways to split a committed file's ref from its path are asked of GitHub. */
export const MAX_REF_SPLITS = 4;

/**
 * Where a committed file's ref may end, most likely first: at a branch in
 * `hints` (the pull request's head and base), then after one, two, three
 * segments. A `refs/heads/` or `refs/tags/` prefix is dropped.
 */
export function refSplits(
  segments: readonly string[],
  hints: readonly string[] = [],
): { ref: string; path: string }[] {
  const parts =
    segments[0] === "refs" && (segments[1] === "heads" || segments[1] === "tags")
      ? segments.slice(2)
      : segments;
  const splits: { ref: string; path: string }[] = [];
  const add = (at: number) => {
    if (at < 1 || at >= parts.length) return;
    const ref = parts.slice(0, at).join("/");
    if (!splits.some((split) => split.ref === ref))
      splits.push({ ref, path: parts.slice(at).join("/") });
  };
  for (const hint of hints) {
    const named = hint.split("/").filter(Boolean);
    if (named.length > 0 && named.every((part, index) => parts[index] === part)) add(named.length);
  }
  for (let at = 1; at < parts.length; at++) add(at);
  return splits.slice(0, MAX_REF_SPLITS);
}

/**
 * Whether the route serves `image` for a pull request of `repo` from
 * `headOwner`'s copy: any upload, and a committed file only from the
 * repository or the head's fork. Another repository's file keeps its own URL.
 */
export function servesImage(image: GitHubImage, repo: Repo, headOwner: string): boolean {
  if (image.kind === "attachment") return true;
  const owner = image.repo.owner;
  return (
    image.repo.name === repo.name.toLowerCase() &&
    (owner === repo.owner.toLowerCase() || owner === headOwner.toLowerCase())
  );
}

/** Longest alt text, HTML tag and destination the scan follows before giving up on one. */
const MAX_ALT = 1_000;
const MAX_TAG = 4_096;
const MAX_PAREN_DEPTH = 32;

/** How much scanning one body may take, per character: hostile text stops being rewritten, not the page. */
const STEPS_PER_CHAR = 8;

type Found = { srcStart: number; srcEnd: number; src: string; end: number; html: boolean };

/**
 * `body` with the source of each GitHub image in it, written as Markdown
 * (`![alt](url)`, `![alt](<url>)`) or as an HTML `<img src>`, replaced by
 * `route(src)` when `serves` accepts it. Links, other images, and anything in
 * a fenced block, a code span or an HTML comment stay as written.
 *
 * One pass, bounded by `STEPS_PER_CHAR` steps a character: GitHub lets anyone
 * who can comment post 65,536 characters, and this runs during render.
 * `work`, when given, receives the steps taken.
 */
export function routeGitHubImages(
  body: string,
  route: (src: string) => string,
  serves: (image: GitHubImage) => boolean = () => true,
  work?: { steps: number },
): string {
  const scan = new Scan(body);
  const out: string[] = [];
  let copied = 0;
  while (scan.at < body.length && scan.steps <= body.length * STEPS_PER_CHAR + 1_024) {
    const found = scan.next();
    if (!found) continue;
    const src = found.html ? decodeEntities(found.src) : unescapeMarkdown(found.src);
    const image = parseGitHubImage(src);
    if (image && serves(image)) {
      const routed = route(src);
      out.push(
        body.slice(copied, found.srcStart),
        found.html ? `"${routed.replaceAll('"', "&quot;")}"` : routed,
      );
      copied = found.srcEnd;
    }
  }
  out.push(body.slice(copied));
  if (work) work.steps = scan.steps;
  return out.join("");
}

/** A cursor over a body that steps past code and comments and stops at each image. */
class Scan {
  at = 0;
  steps = 0;
  /** For each backtick run length, a position from which no closing run follows. */
  private readonly unclosed = new Map<number, number>();

  private readonly body: string;

  constructor(body: string) {
    this.body = body;
  }

  /** Moves past one construct; the image found there, if any. */
  next(): Found | null {
    const { body } = this;
    const start = this.at;
    this.steps += 1;
    const char = body[start];
    if ((start === 0 || body[start - 1] === "\n") && (this.skipFence() || this.skipIndented()))
      return null;
    if (char === "\\") {
      this.at = start + 2;
      return null;
    }
    if (char === "`") {
      this.skipCode();
      return null;
    }
    if (char === "<" && body.startsWith("<!--", start)) {
      const end = body.indexOf("-->", start + 4);
      this.at = end < 0 ? body.length : end + 3;
      this.steps += this.at - start;
      return null;
    }
    if (char === "<" && /^<(?:pre|code)[\s>]/i.test(body.slice(start, start + 6))) {
      this.skipHtmlCode();
      return null;
    }
    if (char === "!" && body[start + 1] === "[") return this.markdownImage();
    if (char === "<" && /^<img[\s/>]/i.test(body.slice(start, start + 5))) return this.htmlImage();
    this.at = start + 1;
    return null;
  }

  /** A fenced block opening on this line: skipped to its closing fence, or to the end. */
  private skipFence(): boolean {
    const { body } = this;
    const lineEnd = body.indexOf("\n", this.at);
    const first = body.slice(this.at, lineEnd < 0 ? body.length : lineEnd);
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(first);
    // A backtick fence's info string holds no backtick: "```x```" is a code span.
    if (!open || (open[1]![0] === "`" && open[2]!.includes("`"))) return false;
    this.steps += first.length;
    const fence = open[1]!;
    let line = body.indexOf("\n", this.at);
    while (line >= 0) {
      const next = body.indexOf("\n", line + 1);
      const text = body.slice(line + 1, next < 0 ? body.length : next);
      this.steps += text.length + 1;
      const close = /^ {0,3}(`+|~+)\s*$/.exec(text);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
        this.at = next < 0 ? body.length : next + 1;
        return true;
      }
      line = next;
    }
    this.at = body.length;
    return true;
  }

  /**
   * An indented code block starting on this line: four spaces or a tab after
   * a blank line that does not follow a list item, whose continuation may be
   * indented the same way. Skipped to the next line that is not indented.
   */
  private skipIndented(): boolean {
    const { body } = this;
    if (!/^(?: {4}|\t)/.test(body.slice(this.at, this.at + 4))) return false;
    if (!this.afterParagraphBreak()) return false;
    let line = this.at;
    while (line < body.length) {
      const end = body.indexOf("\n", line);
      const next = end < 0 ? body.length : end + 1;
      const text = body.slice(line, next);
      this.steps += text.length;
      if (text.trim() !== "" && !/^(?: {4}|\t)/.test(text)) break;
      line = next;
    }
    this.at = line;
    return true;
  }

  /** Whether the line at `this.at` follows a blank line whose paragraph above is not a list item. */
  private afterParagraphBreak(): boolean {
    const { body } = this;
    if (this.at === 0) return true;
    const blankEnd = this.at - 1;
    const blankStart = body.lastIndexOf("\n", blankEnd - 1) + 1;
    if (body.slice(blankStart, blankEnd).trim() !== "") return false;
    if (blankStart === 0) return true;
    const aboveStart = body.lastIndexOf("\n", blankStart - 2) + 1;
    const above = body.slice(aboveStart, blankStart - 1);
    this.steps += above.length;
    return !/^\s*(?:[-*+]|\d+[.)])\s/.test(above) && !/^(?: {4}|\t)/.test(above);
  }

  /** Positions from which no closing tag follows, by tag name. */
  private readonly unclosedTags = new Map<string, number>();

  /** `<pre>` or `<code>` HTML: skipped to its closing tag, else just the opening one. */
  private skipHtmlCode() {
    const { body } = this;
    const name = /^<(pre|code)/i.exec(body.slice(this.at, this.at + 5))![1]!.toLowerCase();
    const from = this.at + name.length + 1;
    const unclosedFrom = this.unclosedTags.get(name);
    const close =
      unclosedFrom !== undefined && unclosedFrom <= from
        ? -1
        : this.lower().indexOf(`</${name}`, from);
    if (close < 0) {
      this.unclosedTags.set(name, from);
      this.at = from;
      return;
    }
    this.steps += close - this.at;
    const end = body.indexOf(">", close);
    this.at = end < 0 ? body.length : end + 1;
  }

  private lowered: string | null = null;
  private lower(): string {
    this.lowered ??= this.body.toLowerCase();
    return this.lowered;
  }

  /** A code span: skipped to the run of as many backticks that closes it, else just the run. */
  private skipCode() {
    const { body } = this;
    let end = this.at;
    while (body[end] === "`") end += 1;
    const length = end - this.at;
    this.steps += length;
    const unclosedFrom = this.unclosed.get(length);
    if (unclosedFrom !== undefined && unclosedFrom <= end) {
      this.at = end;
      return;
    }
    let cursor = end;
    while (cursor < body.length) {
      this.steps += 1;
      if (body[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      let run = cursor;
      while (body[run] === "`") run += 1;
      this.steps += run - cursor;
      if (run - cursor === length) {
        this.at = run;
        return;
      }
      cursor = run;
    }
    this.unclosed.set(length, end);
    this.at = end;
  }

  /** `![alt](destination`: the destination, with balanced parentheses, or `<…>`. */
  private markdownImage(): Found | null {
    const start = this.at;
    this.at = start + 2;
    const close = this.altEnd(start + 2);
    if (close < 0 || this.body[close + 1] !== "(") return null;
    let cursor = close + 2;
    while (this.body[cursor] === " " || this.body[cursor] === "\t") cursor += 1;
    const found =
      this.body[cursor] === "<" ? this.angledDestination(cursor) : this.bareDestination(cursor);
    if (found) this.at = found.end;
    return found;
  }

  /** The `]` that closes an image's alt text from `from`, nested brackets counted; -1 if none near. */
  private altEnd(from: number): number {
    const { body } = this;
    let depth = 1;
    for (let cursor = from; cursor < body.length && cursor - from <= MAX_ALT; cursor++) {
      this.steps += 1;
      const char = body[cursor];
      if (char === "\\") cursor += 1;
      else if (char === "[") depth += 1;
      else if (char === "]") depth -= 1;
      else if (char === "\n" && body[cursor + 1] === "\n") return -1;
      if (depth === 0) return cursor;
    }
    return -1;
  }

  /** `<destination>` from the `<` at `open`. */
  private angledDestination(open: number): Found | null {
    const close = this.until(open + 1, (char) => char === ">" || char === "<" || char === "\n");
    if (close < 0 || this.body[close] !== ">") return null;
    const src = this.body.slice(open + 1, close);
    return { srcStart: open + 1, srcEnd: close, src, end: close + 1, html: false };
  }

  /** A bare destination from `start`: up to space or the `)` its parentheses leave unbalanced. */
  private bareDestination(start: number): Found | null {
    const { body } = this;
    let cursor = start;
    let parens = 0;
    for (; cursor < body.length && cursor - start <= MAX_IMAGE_URL; cursor++) {
      this.steps += 1;
      const char = body[cursor]!;
      if (char <= " " || (char === ")" && parens === 0)) break;
      if (char === "\\") cursor += 1;
      else if (char === "(") parens += 1;
      else if (char === ")") parens -= 1;
      if (parens > MAX_PAREN_DEPTH) return null;
    }
    if (cursor === start || parens !== 0) return null;
    return {
      srcStart: start,
      srcEnd: cursor,
      src: body.slice(start, cursor),
      end: cursor,
      html: false,
    };
  }

  /** `<img … src=…>`: its `src` value, quotes included in the span replaced. */
  private htmlImage(): Found | null {
    const { body } = this;
    const start = this.at;
    const close = this.until(start + 1, (char) => char === ">" || char === "<");
    this.at = start + 1;
    if (close < 0 || body[close] !== ">") return null;
    const tag = body.slice(start, close);
    this.at = close + 1;
    this.steps += tag.length;
    // Attribute by attribute, so a quoted value such as alt="x src=…" is never taken for one.
    for (const attribute of tag.slice(4).matchAll(HTML_ATTRIBUTE)) {
      if (attribute[1]!.toLowerCase() !== "src") continue;
      const value = attribute[2] ?? attribute[3] ?? attribute[4];
      if (value === undefined) return null;
      const quoted = attribute[4] === undefined ? 2 : 0;
      const srcEnd = start + 4 + attribute.index + attribute[0].length;
      return {
        srcStart: srcEnd - value.length - quoted,
        srcEnd,
        src: value,
        end: close + 1,
        html: true,
      };
    }
    return null;
  }

  /** The first position from `from` where `stop` holds, within `MAX_TAG`; -1 past it or the end. */
  private until(from: number, stop: (char: string) => boolean): number {
    const { body } = this;
    for (let cursor = from; cursor < body.length && cursor - from <= MAX_TAG; cursor++) {
      this.steps += 1;
      if (stop(body[cursor]!)) return cursor;
    }
    return -1;
  }
}

/** One HTML attribute: its name, and its value quoted either way or bare. */
const HTML_ATTRIBUTE = /\s+([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/** A Markdown destination as the renderer reads it: `\(` is `(`. */
function unescapeMarkdown(value: string): string {
  return value.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/** The entities GitHub writes in an attribute's URL. */
function decodeEntities(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}
