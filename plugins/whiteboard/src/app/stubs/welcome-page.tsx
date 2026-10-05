import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import type {
  ReviewCanvasInstallContent,
  ReviewCanvasOnboarding,
  ReviewCanvasSetupActions,
} from "../../shared/vendor/review-protocol/src/index.ts";
import { Button } from "../components/ui/button.tsx";
import { EmptyState } from "../panel/empty-state.tsx";
import { copyText } from "../vendor/review/app/src/copy-text.tsx";
import { PROMPTS, type PromptKind } from "../vendor/review/app/src/prompt-card.tsx";

export const NO_WHITEBOARDS_TITLE = "No Whiteboards yet.";
export const NO_WHITEBOARDS_DESCRIPTION = "Ask an agent, or type /whiteboard in any thread.";

/** Upstream `prompt-card.tsx` tabs, which it does not export. */
const PROMPT_KINDS: ReadonlyArray<{ kind: PromptKind; label: string }> = [
  { kind: "change", label: "Review a change" },
  { kind: "architecture", label: "Architecture review" },
];

const COPIED_RESET_MS = 2000;

/**
 * Replaces upstream `welcome-page.tsx` (design §2.3 D). CLI and MCP setup does
 * not apply inside bb: the tools are always registered. Home renders this
 * while its list is empty, so it is bb's empty state with the same props.
 *
 * Upstream's prompt card ends in "Copy prompt" because its agent runs in
 * another app. Here the agent is one click away, so the primary action opens
 * bb's new-thread composer with the prompt. It never touches a thread's
 * draft.
 */
export function WelcomePage(_props: {
  install?: ReviewCanvasInstallContent;
  setupActions?: ReviewCanvasSetupActions;
  onClose?: () => void;
  onDismissUpdate?: () => void;
  onboarding?: ReviewCanvasOnboarding;
  onOpenTutorial?: () => void;
}) {
  const navigate = useBbNavigate();
  const [kind, setKind] = useState<PromptKind>("change");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <EmptyState title={NO_WHITEBOARDS_TITLE} description={NO_WHITEBOARDS_DESCRIPTION}>
      <section className="review-home-prompt-card" aria-label="Whiteboard prompt">
        {/* Upstream's segmented tabs; a <fieldset> would bring its own frame. */}
        {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role */}
        <div className="review-home-prompt-tabs" role="group" aria-label="What to review">
          {PROMPT_KINDS.map(({ kind: tab, label }) => (
            <button
              key={tab}
              type="button"
              className={kind === tab ? "is-active" : undefined}
              aria-pressed={kind === tab}
              onClick={() => {
                setKind(tab);
                setCopied(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <pre className="review-home-prompt-body">{PROMPTS[kind]}</pre>
        <div className="review-home-prompt-actions gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-live="polite"
            onClick={() => void copyText(PROMPTS[kind]).then(setCopied)}
          >
            {copied ? "Copied" : "Copy prompt"}
          </Button>
          <Button
            size="sm"
            onClick={() => navigate.toCompose({ initialPrompt: PROMPTS[kind], focusPrompt: true })}
          >
            Start in a new thread
          </Button>
        </div>
      </section>
    </EmptyState>
  );
}
