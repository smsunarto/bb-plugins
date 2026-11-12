/**
 * Where Radix portals Source Control's overlays: one scope root on
 * document.body named for this plugin. The plugin's stylesheet is scoped to
 * `[data-bb-plugin="source-control"]`, and `escape.ts` tells this plugin's
 * menus from bb's own pickers by that same root, so overlay content must
 * land inside it rather than loose in body.
 */
const ID = "source-control";

let root: HTMLElement | null = null;

export function portalContainer(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined;
  if (root?.isConnected) return root;
  root = document.createElement("div");
  root.setAttribute("data-bb-plugin", ID);
  root.setAttribute("data-bb-portaled-overlay", "");
  document.body.append(root);
  return root;
}
