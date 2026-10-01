// Vendored from dev.fast review/app/src/tutorial-authoring-conversation.tsx @4ecc570 (MIT).
import type { ReactElement } from "react";

import type { ReviewComponentProps } from "../../../../../shared/vendor/review/src/review-document-data.ts";

export function TutorialAuthoringConversation({
  conversation,
}: ReviewComponentProps<"TutorialAuthoringConversation">): ReactElement {
  return (
    <details className="tutorial-authoring-conversation">
      <summary>
        <span>{conversation.title}</span>
        <span>Representative authoring conversation</span>
      </summary>
      <ol>
        {conversation.messages.map((message, index) => (
          <li key={`${message.role}-${index}`} data-role={message.role}>
            <span>{message.role === "user" ? "You" : "Agent"}</span>
            <p>{message.body}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}
