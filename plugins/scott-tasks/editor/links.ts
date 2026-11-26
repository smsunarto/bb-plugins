const UNICODE_WHITESPACE_OR_CONTROL =
  /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]+/g;
const URL_SCHEME = /^[^/?#]*:/;
const ALLOWED_SCHEME = /^(?:https?|mailto):/i;
const NETWORK_PATH = /^[/\\]{2}/;

function normalizeHref(href: string): string {
  return href.replace(UNICODE_WHITESPACE_OR_CONTROL, "");
}

export function isAllowedEditorLink(href: string): boolean {
  const normalized = normalizeHref(href);
  if (normalized === "" || NETWORK_PATH.test(normalized)) return false;
  if (URL_SCHEME.test(normalized)) return ALLOWED_SCHEME.test(normalized);
  return true;
}

export function handleEditorLinkClick(
  event: MouseEvent,
  open: { url(href: string): boolean; relative?(href: string): boolean },
): boolean {
  if (event.button !== 0 || event.shiftKey || !(event.target instanceof Element)) return false;
  const href = event.target.closest("a[href]")?.getAttribute("href");
  if (!href) return false;
  event.preventDefault();
  const normalized = normalizeHref(href);
  if (!isAllowedEditorLink(href)) return false;
  return URL_SCHEME.test(normalized) ? open.url(href) : (open.relative?.(href) ?? false);
}
