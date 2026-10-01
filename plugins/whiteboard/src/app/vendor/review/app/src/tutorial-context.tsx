// Vendored from dev.fast review/app/src/tutorial-context.tsx @4ecc570 (MIT).
import type { ReviewCanvasTutorialBridge } from "../../../../../shared/vendor/review-protocol/src/index.ts";
import { type ReactNode, createContext, useContext } from "react";

const TutorialContext = createContext<ReviewCanvasTutorialBridge | null>(null);

export function TutorialProvider({
  tutorial,
  children,
}: {
  tutorial?: ReviewCanvasTutorialBridge;
  children: ReactNode;
}) {
  return (
    <TutorialContext.Provider value={tutorial ?? null}>
      {children}
    </TutorialContext.Provider>
  );
}

export function useTutorial(): ReviewCanvasTutorialBridge | null {
  return useContext(TutorialContext);
}
