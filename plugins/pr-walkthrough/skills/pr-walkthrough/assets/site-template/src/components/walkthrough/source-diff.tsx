"use client"

import type { DiffLineAnnotation } from "@pierre/diffs"
import { PatchDiff, type VirtualFileMetrics } from "@pierre/diffs/react"
import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import { ChevronDown, FileCode2, FileCog, MessageSquareText, Square, SquareCheckBig } from "lucide-react"

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Toggle } from "@/components/ui/toggle"
import type { WalkthroughDiffFile, WalkthroughFile } from "@/data/walkthrough"
import { cn } from "@/lib/utils"

import { createDiffOptions, type ReviewDiffStyle } from "./diff-options"
import { REVIEW_SURFACE_CLASS } from "./review-surface"

const DIFF_METRICS: VirtualFileMetrics = {
  diffHeaderHeight: 44,
  hunkLineCount: 50,
  lineHeight: 20,
  paddingBottom: 0,
  spacing: 8,
}

type SourceDiffProps = {
  diffStyle: ReviewDiffStyle
  evidence: WalkthroughFile[]
  expandedPaths: Set<string>
  files: WalkthroughDiffFile[]
  onExpandedPathChange: (path: string, expanded: boolean) => void
  onToggleReviewed: (path: string) => void
  reviewedPaths: Set<string>
}

export type ReviewDiffSurfaceProps<LAnnotation = undefined> = {
  diffStyle: ReviewDiffStyle
  expanded: boolean
  file: WalkthroughDiffFile
  itemId?: string
  lineAnnotations?: DiffLineAnnotation<LAnnotation>[]
  note?: string
  onToggleExpanded: () => void
  onToggleReviewed: () => void
  rangeLabel?: string
  renderAnnotation?: (annotation: DiffLineAnnotation<LAnnotation>) => ReactNode
  reviewed: boolean
  useFullFileContext?: boolean
}

export function ReviewDiffSurface<LAnnotation = undefined>({
  diffStyle,
  expanded,
  file,
  itemId,
  lineAnnotations,
  note,
  onToggleExpanded,
  onToggleReviewed,
  rangeLabel,
  renderAnnotation,
  reviewed,
  useFullFileContext = true,
}: ReviewDiffSurfaceProps<LAnnotation>) {
  const fileName = file.path.split("/").at(-1) ?? file.path
  const options = createDiffOptions<LAnnotation>(diffStyle, !expanded, useFullFileContext ? file : undefined)
  const annotationCount = lineAnnotations?.length ?? 0

  function handleDiffClick(event: ReactMouseEvent<HTMLDivElement>) {
    const clickedHeader = event.nativeEvent.composedPath().some(
      (target) => target instanceof HTMLElement && target.hasAttribute("data-diffs-header"),
    )

    if (clickedHeader) onToggleExpanded()
  }

  return (
    <section
      className={cn("w-full min-w-0 max-w-full", REVIEW_SURFACE_CLASS)}
      data-diff-item-id={itemId ?? file.path}
      data-file-path={file.path}
      data-diff-file-path={file.path}
      data-generated={file.generated || file.binary ? "true" : "false"}
      data-reviewed={reviewed ? "true" : "false"}
    >
      <div className="diff-viewport w-full min-w-0 max-w-full overflow-hidden" data-diff-path={file.path}>
        <div className="inline-diff w-full min-w-0 max-w-full" onClick={handleDiffClick}>
          <PatchDiff<LAnnotation>
            className="block w-full min-w-0"
            disableWorkerPool
            lineAnnotations={lineAnnotations}
            metrics={DIFF_METRICS}
            options={options}
            patch={file.patch}
            renderAnnotation={renderAnnotation}
            renderHeaderFilenameSuffix={() => note || rangeLabel || (!expanded && annotationCount > 0) ? (
              <span className="inline-flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground">
                {rangeLabel ? <span className="hidden shrink-0 font-mono sm:inline">{rangeLabel}</span> : null}
                {note ? <span className="hidden max-w-[28rem] truncate xl:inline" title={note}>{note}</span> : null}
                {!expanded && annotationCount > 0 ? (
                  <span className="inline-flex shrink-0 items-center gap-1" title={`${annotationCount} read-only ${annotationCount === 1 ? "note" : "notes"}`}>
                    <MessageSquareText className="size-3" />{annotationCount}
                  </span>
                ) : null}
              </span>
            ) : null}
            renderHeaderMetadata={() => (
              <Toggle
                aria-label={reviewed ? `Mark ${fileName} as not reviewed` : `Mark ${fileName} reviewed`}
                className={`mr-[-8px] h-auto min-w-0 shrink-0 cursor-pointer gap-1 rounded-md border p-1 text-xs font-normal transition ${reviewed ? "border-primary/50 bg-primary/25 text-foreground hover:bg-primary/30" : "border-foreground/20 bg-transparent text-foreground/70 hover:border-foreground/35 hover:bg-foreground/5 hover:text-foreground/85"}`}
                onClick={(event) => event.stopPropagation()}
                onPressedChange={(pressed) => {
                  if (pressed === reviewed) return
                  onToggleReviewed()
                  if (pressed && expanded) onToggleExpanded()
                }}
                pressed={reviewed}
                size="sm"
              >
                {reviewed ? <SquareCheckBig className="size-4 text-primary" /> : <Square className="size-4 text-foreground/50" />}
                <span>Viewed</span>
              </Toggle>
            )}
            renderHeaderPrefix={() => (
              <button
                aria-expanded={expanded}
                aria-label={expanded ? `Collapse ${fileName}` : `Expand ${fileName}`}
                aria-pressed={!expanded}
                className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md p-0 text-foreground/65 transition hover:bg-foreground/10 hover:text-foreground"
                style={{ marginLeft: -5 }}
                type="button"
              >
                <ChevronDown className={`h-4 w-2.5 transition-transform ${expanded ? "" : "-rotate-90"}`} />
              </button>
            )}
          />
        </div>
      </div>
      {expanded && file.binary ? (
        <div className="border-t p-3">
          <Alert><FileCode2 /><AlertDescription>Binary change. Open the pull request to inspect its preview.</AlertDescription></Alert>
        </div>
      ) : null}
    </section>
  )
}

export function SourceDiff({
  diffStyle,
  evidence,
  expandedPaths,
  files,
  onExpandedPathChange,
  onToggleReviewed,
  reviewedPaths,
}: SourceDiffProps) {
  const noteByPath = useMemo(() => new Map(evidence.map((file) => [file.path, file.note])), [evidence])

  function toggleExpanded(path: string) {
    onExpandedPathChange(path, !expandedPaths.has(path))
  }

  function renderFile(file: WalkthroughDiffFile) {
    return (
      <ReviewDiffSurface
        diffStyle={diffStyle}
        expanded={expandedPaths.has(file.path)}
        file={file}
        key={file.path}
        note={noteByPath.get(file.path)}
        onToggleExpanded={() => toggleExpanded(file.path)}
        onToggleReviewed={() => onToggleReviewed(file.path)}
        reviewed={reviewedPaths.has(file.path)}
      />
    )
  }

  if (files.length === 0) {
    return null
  }

  return (
    <div className="space-y-3">{files.map(renderFile)}</div>
  )
}

export function GeneratedSourceDiff(props: SourceDiffProps) {
  const { expandedPaths, files } = props
  const [open, setOpen] = useState(false)
  const filePathKey = files.map((file) => file.path).join("\n")

  useEffect(() => {
    if (files.some((file) => expandedPaths.has(file.path))) setOpen(true)
  }, [expandedPaths, filePathKey, files])

  if (files.length === 0) return null

  return (
    <section className="pb-6 pt-3" data-generated-section>
      <Accordion collapsible onValueChange={(value) => setOpen(value === "generated-files")} type="single" value={open ? "generated-files" : ""}>
        <AccordionItem className="border-0" value="generated-files">
          <AccordionTrigger className="min-h-9 items-center border-x-0 border-b border-t-0 px-0 py-2 hover:no-underline">
            <span className="flex min-w-0 items-center gap-2">
              <FileCog className="size-4 text-muted-foreground" />
              <span>Generated and binary files</span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="pt-3 pb-0">
            <SourceDiff {...props} />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  )
}
