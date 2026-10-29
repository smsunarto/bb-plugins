const MAX_ICON_NAME_LENGTH = 256;

// bb's Plugins icon (the sidebar's Plugins row). Used for plugins that are not
// installed yet and for installed plugins whose branding has no icon name.
export const PLUGIN_ICON = "Plug02";

// Mirrors bb's NAMESPACED_GLYPH_PATTERN for "<pluginId>/<name>" asset icons.
const NAMESPACED_ICON = /^[a-z0-9-]+\/[a-z0-9][a-z0-9-]*$/u;

// Branding icons are either an icon name (built-in or registered) or a
// plugin-owned file path, which bb marks with a "./" prefix; only names can be
// handed to the host.
export function iconName(icon: string | null | undefined): string | undefined {
  const value = icon?.trim();
  if (!value || value.length > MAX_ICON_NAME_LENGTH || value.startsWith("./")) return undefined;
  return value;
}

function assetHash(url: string): string | null {
  try {
    return new URL(url, "http://bb.invalid").searchParams.get("h");
  } catch {
    return null;
  }
}

// File-branded plugins are only addressable by name when the same artwork is
// also declared in bb.branding.experimental_icons, which the host registers as
// "<pluginId>/<name>". Match by the asset URLs' content hash so a different
// icon is never shown; anything unmatched uses the Plugins icon. Hosts before
// plugin SDK 0.4.16 omit `icons`.
export function installedIconName(plugin: {
  id: string;
  icon: string | null;
  iconUrl?: string | null;
  icons?: Readonly<Record<string, string>> | null;
}): string {
  const named = iconName(plugin.icon);
  if (named !== undefined) return named;
  const hash = plugin.iconUrl ? assetHash(plugin.iconUrl) : null;
  const match =
    hash === null
      ? undefined
      : Object.entries(plugin.icons ?? {}).find(([, url]) => assetHash(url) === hash);
  const asset = match === undefined ? "" : `${plugin.id}/${match[0]}`;
  return NAMESPACED_ICON.test(asset) ? asset : PLUGIN_ICON;
}
