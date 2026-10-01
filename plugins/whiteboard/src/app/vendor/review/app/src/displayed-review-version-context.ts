// Vendored from dev.fast review/app/src/displayed-review-version-context.ts @4ecc570 (MIT).
import { createContext } from "react";

export const DisplayedReviewVersionContext = createContext<number | undefined>(
  undefined,
);
