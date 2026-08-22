/**
 * Wire-name derivation (§3, ADR-0008). A Wire name is public API —
 * renaming one is a breaking change — so the derivation is pinned:
 * `-` becomes `_`, an underscore lands between a lowercase/digit and the
 * uppercase that follows it, then everything lowercases. Deliberately
 * acronym-unaware: `readURLPath` → `read_urlpath`, not `read_url_path`.
 */
const BOUNDARY = /([a-z0-9])([A-Z])/g;

function snakeName(value: string): string {
  return value.replaceAll("-", "_").replace(BOUNDARY, "$1_$2").toLowerCase();
}

/** The kebab form of a procedure key, for the RPC subtree (ADR-0013). */
export function kebabName(key: string): string {
  return key.replace(BOUNDARY, "$1-$2").toLowerCase();
}

/** The public Wire name of a procedure: `snake(namespace)_snake(key)`. */
export function wireName(namespace: string, key: string): string {
  return `${snakeName(namespace)}_${snakeName(key)}`;
}
