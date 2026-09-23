import type { ReactNode } from "react";
import { Button } from "./components/ui/button.tsx";

/** The panel's one way of saying "nothing to draw here, and why". */
export function Notice({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className="my-4 rounded-md border border-border bg-card px-3 py-2.5 text-muted-foreground">
      <p className="font-semibold text-foreground">{title}</p>
      {/* Detail wraps to several lines often enough to need reading leading. */}
      {detail ? <p className="mt-1 leading-normal [overflow-wrap:anywhere]">{detail}</p> : null}
      {onRetry ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 h-6 px-2.5 text-xs font-normal"
          onClick={onRetry}
        >
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The panel refetches on its own, so a screen reader needs the load announced
 * rather than only drawn. `output` is the native polite live region, so the
 * announcement costs no ARIA.
 */
export function Loading({ label }: { label: string }) {
  return <output className="my-2.5 block text-muted-foreground">{label}</output>;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed without an error message.";
}
