"use client"

import type { DiffLineAnnotation } from "@pierre/diffs"
import { useMemo, useState, type ComponentProps } from "react"

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type {
  WalkthroughDiffFile,
  WalkthroughGuideComment,
  WalkthroughGuideExcerpt,
  WalkthroughGuidePhase,
  WalkthroughReviewGroup,
} from "@/data/walkthrough"

import type { ReviewDiffStyle } from "./diff-options"
import { GuideContent } from "./guide-content"
import { GuideDiagram } from "./guide-diagram"
import { GuideLineComment } from "./guide-line-comment"
import { ReviewDiffSurface } from "./source-diff"

type GuideDocumentProps = {
  diffStyle: ReviewDiffStyle
  expandedExcerptIds: Set<string>
  group: WalkthroughReviewGroup
  groupFiles: WalkthroughDiffFile[]
  onExpandedExcerptIdsChange: (ids: string[]) => void
  onSetDiffStyle: (style: ReviewDiffStyle) => void
  onToggleExcerptReviewed: (id: string) => void
  reviewedExcerptIds: Set<string>
}

function getPhaseProgress(phase: WalkthroughGuidePhase, reviewedExcerptIds: Set<string>) {
  const required = phase.excerpts.filter((excerpt) => excerpt.countsTowardCompletion)
  const optional = phase.excerpts.filter((excerpt) => !excerpt.countsTowardCompletion)
  const requiredReviewed = required.filter((excerpt) => reviewedExcerptIds.has(excerpt.id)).length
  const optionalViewed = optional.filter((excerpt) => reviewedExcerptIds.has(excerpt.id)).length

  return {
    optionalLabel: optional.length > 0 ? `${optionalViewed} of ${optional.length} optional viewed` : undefined,
    requiredLabel: required.length > 0 ? `${requiredReviewed} of ${required.length} hunks reviewed` : undefined,
  }
}

function GuideDiffExcerpt({
  diffStyle,
  excerpt,
  expanded,
  file,
  onToggleExpanded,
  onToggleReviewed,
  reviewed,
}: {
  diffStyle: ReviewDiffStyle
  excerpt: WalkthroughGuideExcerpt
  expanded: boolean
  file: WalkthroughDiffFile
  onToggleExpanded: () => void
  onToggleReviewed: () => void
  reviewed: boolean
}) {
  const lineAnnotations = useMemo<DiffLineAnnotation<WalkthroughGuideComment>[]>(() => excerpt.comments.map((comment) => ({
    lineNumber: comment.lineNumber,
    metadata: comment,
    side: comment.side,
  })), [excerpt.comments])
  const excerptFile = useMemo<WalkthroughDiffFile>(() => ({
    ...file,
    additions: excerpt.additions,
    binary: excerpt.binary,
    deletions: excerpt.deletions,
    generated: excerpt.generated,
    patch: excerpt.patch,
  }), [excerpt, file])

  return (
    <article className="space-y-3" data-guide-excerpt-id={excerpt.id}>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{excerpt.title}</h3>
        <GuideContent blocks={excerpt.explanation} />
      </div>
      <ReviewDiffSurface<WalkthroughGuideComment>
        diffStyle={diffStyle}
        expanded={expanded}
        file={excerptFile}
        itemId={excerpt.id}
        lineAnnotations={lineAnnotations}
        onToggleExpanded={onToggleExpanded}
        onToggleReviewed={onToggleReviewed}
        rangeLabel={excerpt.rangeLabel}
        renderAnnotation={(annotation) => annotation.metadata ? <GuideLineComment comment={annotation.metadata} /> : null}
        reviewed={reviewed}
        useFullFileContext={false}
      />
    </article>
  )
}

function PhaseContents({
  diffByPath,
  diffStyle,
  expandedExcerptIds,
  onExpandedExcerptIdsChange,
  onToggleExcerptReviewed,
  phase,
  reviewedExcerptIds,
}: {
  diffByPath: Map<string, WalkthroughDiffFile>
  diffStyle: ReviewDiffStyle
  expandedExcerptIds: Set<string>
  onExpandedExcerptIdsChange: (ids: string[]) => void
  onToggleExcerptReviewed: (id: string) => void
  phase: WalkthroughGuidePhase
  reviewedExcerptIds: Set<string>
}) {
  function toggleExpanded(id: string) {
    const next = new Set(expandedExcerptIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onExpandedExcerptIdsChange([...next])
  }

  return (
    <div className="space-y-5">
      <GuideContent blocks={phase.explanation} />
      {phase.diagram ? <GuideDiagram diagram={phase.diagram} /> : null}
      {phase.excerpts.map((excerpt) => {
        const file = diffByPath.get(excerpt.path)
        if (!file) return null
        return (
          <GuideDiffExcerpt
            diffStyle={diffStyle}
            excerpt={excerpt}
            expanded={expandedExcerptIds.has(excerpt.id)}
            file={file}
            key={excerpt.id}
            onToggleExpanded={() => toggleExpanded(excerpt.id)}
            onToggleReviewed={() => onToggleExcerptReviewed(excerpt.id)}
            reviewed={reviewedExcerptIds.has(excerpt.id)}
          />
        )
      })}
    </div>
  )
}

function GuidePhaseSection(props: Omit<ComponentProps<typeof PhaseContents>, "phase"> & { phase: WalkthroughGuidePhase }) {
  const { phase } = props
  const [open, setOpen] = useState(!phase.defaultCollapsed)
  const progress = getPhaseProgress(phase, props.reviewedExcerptIds)
  const countLabel = [progress.requiredLabel, progress.optionalLabel].filter(Boolean).join(" · ")

  if (!phase.defaultCollapsed) {
    return (
      <section className="space-y-4" data-guide-phase-id={phase.id}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">{phase.title}</h2>
          <span className="font-mono text-[11px] text-muted-foreground">{countLabel}</span>
        </div>
        <PhaseContents {...props} />
      </section>
    )
  }

  return (
    <section data-guide-phase-id={phase.id}>
      <Accordion collapsible onValueChange={(value) => setOpen(value === phase.id)} type="single" value={open ? phase.id : ""}>
        <AccordionItem className="border-0" value={phase.id}>
          <AccordionTrigger className="min-h-9 items-center border-x-0 border-b border-t-0 px-0 py-2 hover:no-underline">
            <span className="flex min-w-0 flex-1 items-center justify-between gap-3 pr-2">
              <span className="text-base font-semibold">{phase.title}</span>
              <span className="font-mono text-[11px] font-normal text-muted-foreground">{countLabel}</span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="pb-0 pt-4"><PhaseContents {...props} /></AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  )
}

export function GuideDocument({
  diffStyle,
  expandedExcerptIds,
  group,
  groupFiles,
  onExpandedExcerptIdsChange,
  onSetDiffStyle,
  onToggleExcerptReviewed,
  reviewedExcerptIds,
}: GuideDocumentProps) {
  const phases = group.guide.phases
  const diffByPath = useMemo(() => new Map(groupFiles.map((file) => [file.path, file])), [groupFiles])

  if (phases.length === 0) return null

  return (
    <div className="mt-4 space-y-7" data-guide-document>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Guide outline</h2>
          <ol className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {phases.map((phase, index) => {
              const progress = getPhaseProgress(phase, reviewedExcerptIds)
              const countLabel = [progress.requiredLabel, progress.optionalLabel].filter(Boolean).join(" · ")
              return (
                <li className="flex min-w-0 items-baseline justify-between gap-3 py-1 text-xs" key={phase.id}>
                  <span className="min-w-0 truncate text-foreground/90"><span className="mr-2 font-mono text-primary">{index + 1}</span>{phase.title}</span>
                  <span className="shrink-0 font-mono text-muted-foreground">{countLabel}</span>
                </li>
              )
            })}
          </ol>
        </div>
        <ToggleGroup
          aria-label="Diff layout"
          className="overflow-hidden rounded-md"
          onValueChange={(value) => {
            if (value === "unified" || value === "split") onSetDiffStyle(value)
          }}
          size="sm"
          spacing={0}
          type="single"
          value={diffStyle}
          variant="outline"
        >
          <ToggleGroupItem className="rounded-l-md! rounded-r-none!" value="unified">Unified</ToggleGroupItem>
          <ToggleGroupItem className="rounded-l-none! rounded-r-md!" value="split">Split</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {phases.map((phase) => (
        <GuidePhaseSection
          diffByPath={diffByPath}
          diffStyle={diffStyle}
          expandedExcerptIds={expandedExcerptIds}
          key={phase.id}
          onExpandedExcerptIdsChange={onExpandedExcerptIdsChange}
          onToggleExcerptReviewed={onToggleExcerptReviewed}
          phase={phase}
          reviewedExcerptIds={reviewedExcerptIds}
        />
      ))}
    </div>
  )
}
