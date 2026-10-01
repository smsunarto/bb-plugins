import type { MouseEvent, ReactElement, ReactNode } from "react";
import { isNumberValue, isStringValue } from "../../shared/vendor/review-protocol/src/index.ts";
import { newTabLinkProps } from "../vendor/review/app/src/link-props.ts";

export type LinkRenderer = (href: string, children: ReactNode) => ReactNode;

/**
 * Upstream `MarkdownLink` (`agent-markdown.tsx:385-414`) on a link mark, with two bb changes:
 * a `renderLink` result sits in a `<span data-wb-href>`, never inside an `<a>`, and a `#fragment`
 * link scrolls in place instead of navigating bb.
 */
export function MarkdownLink({
  href,
  title,
  children,
  renderLink,
}: {
  href: string;
  title?: string;
  children: ReactNode;
  renderLink?: LinkRenderer;
}): ReactElement {
  const custom = renderLink?.(href, children);

  if (custom !== undefined) return <span data-wb-href={href}>{custom}</span>;

  if (isLocalFilesystemHref(href))
    return (
      <code className="agent-markdown-code-reference">
        {textFromChildren(children) ?? "local file"}
      </code>
    );

  if (!safeMarkdownHref(href)) return <span>{children}</span>;

  if (href.startsWith("#"))
    return (
      <a href={href} title={title} onClick={scrollToFragment}>
        {children}
      </a>
    );

  return (
    <a href={href} title={title} {...newTabLinkProps(href)}>
      {children}
    </a>
  );
}

/**
 * Scroll to `#id` inside the canvas. Upstream let the browser follow the fragment, which in bb
 * would rewrite the app's URL. A document's own heading listener (`api-document.tsx`
 * `useHeadingFragments`) runs first and prevents default when it handles the click.
 */
export function scrollToFragment(event: MouseEvent<HTMLAnchorElement>): void {
  if (event.nativeEvent.defaultPrevented) return;
  event.preventDefault();

  const id = event.currentTarget.getAttribute("href")?.slice(1);
  if (!id) return;
  const root =
    event.currentTarget.closest(".review-canvas-root") ?? event.currentTarget.ownerDocument;
  root
    .querySelector(`[id="${id.replace(/["\\]/g, "\\$&")}"]`)
    ?.scrollIntoView({ behavior: "auto", block: "start" });
}

function safeMarkdownHref(value: string | undefined): string | null {
  if (!value) return null;

  if (value.startsWith("#")) return value;

  if (isLocalFilesystemHref(value)) return null;
  const protocol = urlProtocol(value);

  return protocol && ["http:", "https:", "mailto:"].includes(protocol) ? value : null;
}

/** The scheme a href resolves to; a relative one counts as the page's own. */
export function urlProtocol(value: string): string | null {
  try {
    return new URL(value, "http://localhost").protocol;
  } catch {
    return null;
  }
}

function isLocalFilesystemHref(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();

  if (/^file:/i.test(trimmed)) return true;

  if (/^[a-z]:[\\/]/i.test(trimmed)) return true;

  return /^\/(?:Users|home|tmp|var|private|Volumes|mnt|workspace)\//.test(trimmed);
}

/** A React child that renders as its own text: a string or a number. */
export function isReactTextNode(node: ReactNode): node is string | number {
  return isStringValue(node) || isNumberValue(node);
}

function textFromChildren(children: ReactNode): string | null {
  if (isReactTextNode(children)) return String(children);

  if (Array.isArray(children)) {
    const text = children
      .map((child) => textFromChildren(child) ?? "")
      .join("")
      .trim();

    return text || null;
  }

  return null;
}
