import type { ReviewKeymapChoice } from "../../shared/review-protocol/index.ts";
import { useState } from "react";

import type { ReviewComponentProps } from "../../shared/review/review-document-data.ts";
import { useTutorial } from "./tutorial-context.tsx";

const choices: readonly { value: ReviewKeymapChoice; label: string }[] = [
  { value: "none", label: "VS Code default" },
  { value: "vim", label: "Vim" },
  { value: "emacs", label: "Emacs" },
];

export function TutorialKeymapPicker(_props: ReviewComponentProps<"TutorialKeymapPicker">) {
  const tutorial = useTutorial();
  const [pending, setPending] = useState<ReviewKeymapChoice | null>(null);

  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a segmented button bar; <fieldset> adds form borders, padding and min-content sizing
    <div className="tutorial-keymap-picker" role="group" aria-label="Keybindings">
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          aria-pressed={tutorial?.content.keymap === choice.value}
          disabled={!tutorial || pending !== null}
          onClick={() => {
            if (!tutorial) return;
            setPending(choice.value);
            void tutorial.selectKeymap(choice.value).finally(() => setPending(null));
          }}
        >
          {pending === choice.value ? "Applying…" : choice.label}
        </button>
      ))}
    </div>
  );
}
