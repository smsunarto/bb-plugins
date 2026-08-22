/**
 * Derive a plugin id from an npm package name (§7). Pinned algorithm:
 * strip the npm scope, strip a leading `bb-plugin-` prefix
 * (case-sensitive, before lowercasing), lowercase, map every character
 * outside `[a-z0-9-]` to `-`, trim leading and trailing `-`, and error
 * if nothing remains. Internal — consumed by the `bb-kit` bin.
 */
export function derivePluginID(packageName: string): string {
  let name = packageName;
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    name = slash === -1 ? name.slice(1) : name.slice(slash + 1);
  }
  if (name.startsWith("bb-plugin-")) {
    name = name.slice("bb-plugin-".length);
  }
  name = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (name === "") {
    throw new Error(`package name "${packageName}" derives an empty plugin id`);
  }
  return name;
}
