/** The role a theme adapts, rendered as `data-bb-control`. Monokai gives a
 * shared control the treatment it gives bb's own control of the same role. */
export type ControlRole = "primary" | "outline" | "secondary" | "field";

const ownFill = /(?:^|\s)(?:[\w-]+:)*bg-/;

/** A caller that sets its own fill opts out of the theme's role treatment. */
export function controlRole(role: ControlRole | undefined, className: unknown) {
  return typeof className === "string" && ownFill.test(className) ? undefined : role;
}
