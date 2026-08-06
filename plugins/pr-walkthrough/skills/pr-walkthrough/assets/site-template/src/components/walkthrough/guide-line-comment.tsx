import { MessageSquareText } from "lucide-react"

import type { WalkthroughGuideComment } from "@/data/walkthrough"

export function GuideLineComment({ comment }: { comment: WalkthroughGuideComment }) {
  return (
    <aside
      aria-label={`Guide note for ${comment.side} line ${comment.lineNumber}`}
      className="mx-3 my-2 flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm leading-5 text-foreground/90"
      data-guide-comment-id={comment.id}
      role="note"
    >
      <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-primary" />
      <p>{comment.body}</p>
    </aside>
  )
}
