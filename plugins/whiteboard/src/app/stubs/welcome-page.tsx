import type {
  ReviewCanvasInstallContent,
  ReviewCanvasOnboarding,
  ReviewCanvasSetupActions,
} from "../../shared/vendor/review-protocol/src/index.ts";
import { EmptyState } from "../panel/empty-state.tsx";
import { PromptCard } from "../vendor/review/app/src/prompt-card.tsx";

export const NO_WHITEBOARDS_TITLE = "No Whiteboards yet.";
export const NO_WHITEBOARDS_DESCRIPTION = "Ask an agent to make one.";

/**
 * Replaces upstream `welcome-page.tsx` (design §2.3 D). CLI and MCP setup does
 * not apply inside bb: the tools are always registered. Home renders this
 * while its list is empty, so it is bb's empty state with the same props.
 */
export function WelcomePage(_props: {
  install?: ReviewCanvasInstallContent;
  setupActions?: ReviewCanvasSetupActions;
  onClose?: () => void;
  onDismissUpdate?: () => void;
  onboarding?: ReviewCanvasOnboarding;
  onOpenTutorial?: () => void;
}) {
  return (
    <EmptyState title={NO_WHITEBOARDS_TITLE} description={NO_WHITEBOARDS_DESCRIPTION}>
      <PromptCard />
    </EmptyState>
  );
}
