import type { MouseEvent, ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { sourceFileLabel, type SourceCaption } from "../../core/source";
import { useUiRuntime } from "../runtime";
import { FOCUS_RING } from "./inputs";
import { FADE, useEntrance } from "./motion";
import { useOpenUrl } from "./perfKit";

const LINK = cn("cursor-pointer rounded-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline", FOCUS_RING);

/** A loaded file the caption names: opens in BB where there is a file viewer. */
function FileName({ path }: { path: string }) {
  const { openFile } = useUiRuntime();
  const label = sourceFileLabel(path);
  if (openFile === null) return <span title={path}>{label}</span>;
  return (
    <button
      type="button"
      title={`Open ${path}`}
      onClick={async () => {
        let opened = false;
        try {
          opened = await openFile(path);
        } catch {
          opened = false;
        }
        if (!opened) toast.error(`Couldn't open ${path}`);
      }}
      className={cn(LINK, "font-mono")}
    >
      {label}
    </button>
  );
}

/** The quiet line under a Table, Chart or Metric saying where its numbers come from. */
export function SourceLine({ caption }: { caption: SourceCaption }) {
  const fade = useEntrance<HTMLParagraphElement>(FADE);
  const openUrl = useOpenUrl();
  let body: ReactNode;
  if (caption.kind === "text") {
    body = caption.text;
  } else if (caption.kind === "url") {
    body = (
      <a
        href={caption.url.href}
        title={caption.url.href}
        onClick={(event: MouseEvent) => {
          // The runtime opens it in the user's browser; the anchor is for semantics and copy-link.
          event.preventDefault();
          openUrl(caption.url.href);
        }}
        className={LINK}
      >
        {caption.label}
      </a>
    );
  } else {
    body = caption.paths.map((path, index) => (
      <span key={path}>
        {index > 0 ? ", " : null}
        <FileName path={path} />
      </span>
    ));
  }
  return (
    <p ref={fade} className="m-0 min-w-0 text-[11px] leading-4 text-subtle-foreground [overflow-wrap:anywhere]">
      Source: {body}
    </p>
  );
}
