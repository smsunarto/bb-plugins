/** git's named escapes in a C-quoted path, by the letter after the backslash. */
export const QUOTED_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  t: "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
};

/**
 * A path as a patch header writes it. `core.quotePath=false` keeps non-ASCII
 * names bare, but a name with a quote, a backslash, or a control character is
 * still C-quoted, with octal escapes for the bytes of anything unprintable.
 */
export function quotedPath(text: string): string {
  if (!/^".*"$/s.test(text)) return text;
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const [, octal, escaped, raw] of text
    .slice(1, -1)
    .matchAll(/\\([0-7]{3})|\\(.)|([^\\]+)/gs)) {
    if (octal !== undefined) bytes.push(Number.parseInt(octal, 8));
    else
      bytes.push(
        ...encoder.encode(escaped === undefined ? raw : (QUOTED_ESCAPES[escaped] ?? escaped)),
      );
  }
  // A name may start with U+FEFF, which the default decoder drops as a BOM.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(bytes));
}
