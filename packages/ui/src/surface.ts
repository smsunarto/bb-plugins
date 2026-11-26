import "./controls.css";
import { styles } from "./styles";
export { BANNER_HOVER } from "./banner-hover";

/** Edge and hover classes for surfaces that are not a Card: pass them to className. */
export const surface = {
  /** bb's 1px border-colored edge, as on a Card. */
  edge: styles["edge"],
  /** A 1px top rule between stacked rows or sections. */
  divider: styles["divider"],
  /** The composer's 0.5px opaque edge, for surfaces stacked on the composer. */
  hairline: styles["hairline"],
  /** Shared prompt-stack banner hover surface (keyed on bb's `.dark`, never OS media). */
  bannerHover: styles["banner-hover"],
} as const;
