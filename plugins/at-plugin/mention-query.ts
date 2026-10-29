import { normalizeUntrustedText } from "./mention-context";

export function isPluginBrowseQuery(query: string): boolean {
  return normalizeUntrustedText(query).toLowerCase() === "plugin";
}
