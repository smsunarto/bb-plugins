import type { DisplayComment } from "../../shared/contract.js";
import { commentByline } from "./time.js";
import { Button } from "@/components/ui/button";

export function CommentAuthor({
  comment,
  onOpenThread,
}: {
  comment: DisplayComment;
  onOpenThread: (threadId: string) => void;
}) {
  const byline = commentByline(comment);
  if (byline.kind === "thread-link") {
    return (
      <Button
        variant="link"
        size="sm"
        onClick={() => onOpenThread(byline.threadId)}
        className="h-auto min-w-0 p-0 font-semibold"
      >
        <span className="truncate" title={byline.title}>
          {byline.title}
        </span>
      </Button>
    );
  }
  return <span className="font-semibold">{byline.name}</span>;
}
