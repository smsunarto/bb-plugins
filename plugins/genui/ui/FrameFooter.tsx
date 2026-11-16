// What sits under a rendered UI on the gallery page (see Frame in LiveUi.tsx):
// a footer naming the example, with Source, Copy and Open. Source opens the
// spec with numbered lines in BB's code viewer, the files it reads, and its
// diagnostics. Chat replies show no chrome under a UI.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { CompactButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Diagnostic } from "../core/types";
import { SourceView, viewerPath } from "./components/code";
import { WithTooltip } from "./components/iconButton";

/** A file the spec reads with Load or Snippet, as the source panel lists it. */
export interface SourceFile {
  /** As the reader knows it: workspace-relative in a reply, under gallery/ in the gallery. */
  readonly path: string;
  readonly kind: "Load" | "Snippet";
  readonly status: "reading" | "read" | { readonly error: string };
}

/** How the gallery names one example and shows it alone. */
export interface GalleryExample {
  /** The file in the plugin's gallery/ folder, e.g. "Provenance-no-receipt.ui". */
  readonly file: string;
  readonly component: string;
  /** "no-receipt" for Provenance-no-receipt.ui; null for the component's plain example. */
  readonly variant: string | null;
  /** Shows this example alone; null where it already is. */
  readonly open: (() => void) | null;
}

/** What the source is written in: the spec language, or an ```app block's HTML. */
export type SourceLanguage = "ui" | "html";

/** "no-receipt" → "No receipt"; the component's plain example is its default. */
export function variantName(variant: string | null): string {
  if (variant === null) return "Default";
  const words = variant.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Provenance, No receipt": how screen readers name an example. */
export function exampleTitle(example: GalleryExample): string {
  return `${example.component}, ${variantName(example.variant)}`;
}

/**
 * Copies what `text()` returns, read only on click; the icon shows a check
 * for a moment after it worked. `what` names it in the toasts.
 */
function useCopy(text: () => string, what: { done: string; failed: string }): { copied: boolean; copy(): void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return {
    copied,
    copy() {
      const failed = (cause: unknown) => toast.error(`${what.failed}: ${cause instanceof Error ? cause.message : String(cause)}`);
      // Written while the click is still running: Safari refuses clipboard writes after it.
      let written: Promise<void>;
      try {
        written = navigator.clipboard.writeText(text());
      } catch (cause) {
        failed(cause);
        return;
      }
      written.then(() => {
        toast.success(what.done);
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1500);
      }, failed);
    },
  };
}

const SOURCE_COPY = { done: "Source copied", failed: "Couldn't copy the source" };

/** The gallery footer's quiet actions: icon and label from 32rem of width, icon alone below it (the label stays for screen readers). */
const ACTION = "size-9 shrink-0 px-0 text-xs [&_[data-icon-root]]:size-3.5 text-muted-foreground hover:text-foreground @lg:h-7 @lg:w-auto @lg:px-2";
const ACTION_LABEL = "sr-only @lg:not-sr-only";

/**
 * The gallery's footer under one example: what it is on the left, Source,
 * Copy and Open on the right. Its height never changes; Source
 * opens the panel below it, inside one bordered box with the footer as its
 * header.
 */
export function GalleryFooter({
  example,
  source,
  language,
  files,
  diagnostics,
}: {
  example: GalleryExample;
  source: string;
  language: SourceLanguage;
  files: readonly SourceFile[];
  diagnostics: readonly Diagnostic[];
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { copied, copy } = useCopy(() => source, SOURCE_COPY);
  return (
    <div
      className={cn(
        "@container overflow-hidden rounded-lg border transition-colors duration-150",
        open ? "border-border bg-background" : "border-transparent",
      )}
    >
      <div
        className={cn(
          "flex h-12 items-center justify-between gap-3 pl-3 pr-1 transition-colors duration-150 @lg:h-9",
          open && "bg-surface-recessed",
        )}
      >
        <div className="flex min-w-0 flex-col gap-1 @lg:flex-row @lg:items-baseline @lg:gap-3">
          <p className="m-0 truncate text-xs leading-4 text-foreground">
            <span className="font-medium">{example.component}</span>
            <span aria-hidden className="px-1 text-subtle-foreground">
              ·
            </span>
            <span className="sr-only">, </span>
            <span className="text-muted-foreground">{variantName(example.variant)}</span>
          </p>
          <span className="truncate font-mono text-[11px] leading-4 text-subtle-foreground">{example.file}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <WithTooltip tip={open ? "Hide the source" : "Show the source"}>
            <CompactButton
              variant="ghost"
              size="xs"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((shown) => !shown)}
              className={cn(ACTION, open && "bg-state-hover text-foreground")}
            >
              <Icon name="Code" aria-hidden className="size-3.5" />
              <span className={ACTION_LABEL}>Source</span>
            </CompactButton>
          </WithTooltip>
          <WithTooltip tip="Copy the source">
            <CompactButton variant="ghost" size="xs" onClick={copy} className={ACTION}>
              <Icon name={copied ? "Check" : "Copy"} aria-hidden className="size-3.5" />
              <span className={ACTION_LABEL}>Copy</span>
            </CompactButton>
          </WithTooltip>
          {example.open === null ? null : (
            <WithTooltip tip="Show this example alone">
              <CompactButton variant="ghost" size="xs" onClick={example.open} className={ACTION}>
                <Icon name="ArrowUpRight" aria-hidden className="size-3.5" />
                <span className={ACTION_LABEL}>Open</span>
              </CompactButton>
            </WithTooltip>
          )}
        </div>
      </div>
      {open ? (
        <SourceBody
          id={panelId}
          name={example.file}
          source={source}
          language={language}
          files={files}
          diagnostics={diagnostics}
        />
      ) : null}
    </div>
  );
}

/** The panel itself: numbered source, then the files it reads and its diagnostics, where there are any. */
function SourceBody({
  id,
  name,
  source,
  language,
  files,
  diagnostics,
}: {
  id: string;
  name: string;
  source: string;
  language: SourceLanguage;
  files: readonly SourceFile[];
  diagnostics: readonly Diagnostic[];
}) {
  // BB's viewer picks its highlighting by extension and has none for .ui; the
  // spec language is JavaScript-shaped, so its calls, strings and lambdas read right that way.
  const viewerName = language === "html" ? name : `${name}.js`;
  return (
    <div id={id} role="region" aria-label={`Source of ${name}`} className="border-t border-border">
      <div className="max-h-80 overflow-auto text-xs">
        <SourceView content={source} path={viewerPath(viewerName, source)} />
      </div>
      {files.length === 0 && diagnostics.length === 0 ? null : (
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 border-t border-border px-3 py-3 text-[11px] leading-4">
          {files.length === 0 ? null : (
            <>
              <dt className="text-muted-foreground">Files</dt>
              <dd className="m-0">
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {files.map((file) => (
                    <li key={`${file.kind}:${file.path}`} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="w-12 shrink-0 text-subtle-foreground">{file.kind}</span>
                      <span className="min-w-0 font-mono text-foreground [overflow-wrap:anywhere]">{file.path}</span>
                      {file.status === "read" ? null : file.status === "reading" ? (
                        <span className="text-subtle-foreground">reading…</span>
                      ) : (
                        <span className="text-destructive">{file.status.error}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          {diagnostics.length === 0 ? null : (
            <>
              <dt className="text-muted-foreground">Diagnostics</dt>
              <dd className="m-0">
                <DiagnosticList diagnostics={diagnostics} />
              </dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

export function DiagnosticList({ diagnostics }: { diagnostics: readonly Diagnostic[] }): ReactNode {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 font-mono text-xs text-muted-foreground">
      {diagnostics.map((diagnostic, index) => (
        <li key={index}>
          <span className="tabular-nums">
            {diagnostic.line}:{diagnostic.column}
          </span>{" "}
          <span className={diagnostic.severity === "error" ? "text-destructive" : "text-warning-text"}>
            {diagnostic.severity}
          </span>
          : {diagnostic.message}
        </li>
      ))}
    </ul>
  );
}
