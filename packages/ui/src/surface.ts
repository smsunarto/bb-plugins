import "./controls.css";
import { styles } from "./styles";

/** Edge classes for surfaces that are not a Card: pass them to className. */
export const surface = {
  /** bb's 1px border-colored edge, as on a Card. */
  edge: styles["edge"],
  /** A 1px top rule between stacked rows or sections. */
  divider: styles["divider"],
  /** The composer's 0.5px opaque edge, for surfaces stacked on the composer. */
  hairline: styles["hairline"],
} as const;
