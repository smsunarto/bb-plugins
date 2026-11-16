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
  | { kind: "attachment"; url: string }
  /** A committed file: `github.com/<owner>/<repo>/(blob|raw)/<ref>/<path>` or `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`. */
  | { kind: "file"; url: string; repo: Repo; ref: string; path: string };

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
 * The GitHub image a URL names, or null for any other URL. A committed file's
 * ref is the first segment after `blob/` or `raw/`: a commit, tag or branch
 * without a slash, as permalinks and GitHub's own drag-and-drop write it.
 */
export function parseGitHubImage(src: string): GitHubImage | null {
  const url = httpsUrl(src);
  const segments = url ? decoded(url.pathname.split("/").filter(Boolean)) : null;
  if (!url || !segments) return null;
  if (url.hostname === "github.com") return onGitHub(url, segments);
  if (url.hostname === "raw.githubusercontent.com") {
    const [owner = "", name = "", ref = "", ...path] = segments;
    return repoNamed(owner, name) && ref && path.length > 0
      ? file(url.href, owner, name, ref, path)
      : null;
  }
  return null;
}

/** `src` as a plain https URL: no credentials, no port. */
function httpsUrl(src: string): URL | null {
  if (src.length > MAX_IMAGE_URL) return null;
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
  const upload = { kind: "attachment" as const, url: url.href };
  if (first === "user-attachments" && second === "assets")
    return segments.length === 3 && assetId(third) ? upload : null;
  if (!repoNamed(first, second)) return null;
  if (third === "assets")
    return /^\d+$/.test(fourth) && assetId(fifth) && rest.length === 0 ? upload : null;
  const committed = third === "raw" || (third === "blob" && url.searchParams.get("raw") === "true");
  return committed && fourth && fifth
    ? file(url.href, first, second, fourth, [fifth, ...rest])
    : null;
}

function file(
  url: string,
  owner: string,
  name: string,
  ref: string,
  path: readonly string[],
): GitHubImage | null {
  if (path.some((part) => part === "." || part === "..")) return null;
  if (!IMAGE_FILE.test(path.at(-1) ?? "")) return null;
  return {
    kind: "file",
    url,
    repo: { owner: owner.toLowerCase(), name: name.toLowerCase() },
    ref,
    path: path.join("/"),
  };
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

/** `![alt](url` and `![alt](<url>`, up to the URL. */
const MARKDOWN_IMAGE = /(!\[(?:[^\]\\]|\\.)*\]\(\s*<?)(https:\/\/[^\s)<>]+)/g;
/** An HTML `<img>` tag's `src`, quoted either way or bare. */
const HTML_IMAGE = /(<img\b[^>]*?\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/**
 * `body` with the source of each GitHub image in it, written as Markdown or as
 * an HTML `<img>`, replaced by `route(src)`. Links and other images stay.
 */
export function routeGitHubImages(
  body: string,
  route: (src: string) => string,
  serves: (image: GitHubImage) => boolean = () => true,
): string {
  const swap = (src: string) => {
    const image = parseGitHubImage(decodeEntities(src));
    return image && serves(image) ? route(src) : null;
  };
  return body
    .replace(MARKDOWN_IMAGE, (match, head: string, src: string) => {
      const routed = swap(src);
      return routed === null ? match : `${head}${routed}`;
    })
    .replace(HTML_IMAGE, (match, head: string, double?: string, single?: string, bare?: string) => {
      const src = double ?? single ?? bare ?? "";
      const routed = swap(decodeEntities(src));
      return routed === null ? match : `${head}"${routed.replaceAll('"', "&quot;")}"`;
    });
}

/** The entities GitHub writes in an attribute's URL. */
function decodeEntities(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}
