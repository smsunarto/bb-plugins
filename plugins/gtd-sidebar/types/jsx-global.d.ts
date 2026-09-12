// @dnd-kit's typings refer to the global `JSX` namespace, which React 19's
// types no longer declare. This aliases it to React's own until dnd-kit
// updates (skipLibCheck is off here on purpose).
import type { JSX as ReactJsx } from "react";

declare global {
  namespace JSX {
    type Element = ReactJsx.Element;
    type ElementClass = ReactJsx.ElementClass;
    type IntrinsicElements = ReactJsx.IntrinsicElements;
  }
}
