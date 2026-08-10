"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { ArrowUpToLine, Check, FileCog, FileDiff } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { WalkthroughDiffFile, WalkthroughReviewGroup } from "@/data/walkthrough"

import type { ReviewDiffStyle } from "./diff-options"
import { ChangedFileTree } from "./changed-file-tree"
import { GuideDocument } from "./guide-document"
import { GeneratedSourceDiff, SourceDiff } from "./source-diff"

export type ReviewMode = "normal" | "guide"

type ReviewDocumentProps = {
  diffStyle: ReviewDiffStyle
  expandedExcerptIds: Set<string>
  expandedPaths: Set<string>
  group: WalkthroughReviewGroup
  groupFiles: WalkthroughDiffFile[]
  groupIndex: number
  inlineEvidence?: ReactNode
  onExpandedExcerptIdsChange: (ids: string[]) => void
  onExpandedPathChange: (path: string, expanded: boolean) => void
  onSelectedPathChange: (path: string) => void
  onSetDiffStyle: (style: ReviewDiffStyle) => void
  onSetReviewMode: (mode: ReviewMode) => void
  onToggleExcerptReviewed: (id: string) => void
  onToggleFileReviewed: (path: string) => void
  onToggleViewed: () => void
  reviewMode: ReviewMode
  reviewedExcerptIds: Set<string>
  reviewedPaths: Set<string>
  selectedPath?: string
  totalGroups: number
  viewed: boolean
}

export function ReviewDocument({
  diffStyle,
  expandedExcerptIds,
  expandedPaths,
  group,
  groupFiles,
  groupIndex,
  inlineEvidence,
  onExpandedExcerptIdsChange,
  onExpandedPathChange,
  onSelectedPathChange,
  onSetDiffStyle,
  onSetReviewMode,
  onToggleExcerptReviewed,
  onToggleFileReviewed,
  onToggleViewed,
  reviewMode,
  reviewedExcerptIds,
  reviewedPaths,
  selectedPath,
  totalGroups,
  viewed,
}: ReviewDocumentProps) {
  const [showGoToTop, setShowGoToTop] = useState(false)
  const [showGeneratedFiles, setShowGeneratedFiles] = useState(false)
  const reviewedCount = groupFiles.filter((file) => reviewedPaths.has(file.path)).length
  const requiredGuideExcerpts = group.guide.phases.flatMap((phase) => phase.excerpts).filter((excerpt) => excerpt.countsTowardCompletion)
  const reviewedGuideCount = requiredGuideExcerpts.filter((excerpt) => reviewedExcerptIds.has(excerpt.id)).length
  const primaryFiles = useMemo(() => groupFiles.filter((file) => !file.generated && !file.binary), [groupFiles])
  const generatedFiles = useMemo(() => groupFiles.filter((file) => file.generated || file.binary), [groupFiles])
  const treeFiles = useMemo(
    () => showGeneratedFiles ? groupFiles : primaryFiles,
    [groupFiles, primaryFiles, showGeneratedFiles],
  )
  const groupProgress = reviewMode === "normal"
    ? groupFiles.length > 0 ? (reviewedCount / groupFiles.length) * 100 : viewed ? 100 : 0
    : requiredGuideExcerpts.length > 0 ? (reviewedGuideCount / requiredGuideExcerpts.length) * 100 : 0
  const reviewStatus = reviewMode === "normal"
    ? groupFiles.length > 0 ? `${reviewedCount} of ${groupFiles.length} files reviewed` : viewed ? "Orientation reviewed" : "Review pending"
    : `${reviewedGuideCount} of ${requiredGuideExcerpts.length} code hunks reviewed`

  useEffect(() => {
    const root = document.querySelector<HTMLElement>(`[data-active-review-group="${CSS.escape(group.id)}"]`)
    const viewport = root?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (!viewport) return undefined
    const update = () => setShowGoToTop(viewport.scrollTop > 8)
    update()
    viewport.addEventListener("scroll", update, { passive: true })
    return () => viewport.removeEventListener("scroll", update)
  }, [group.id])

  function scrollToTop() {
    const root = document.querySelector<HTMLElement>(`[data-active-review-group="${CSS.escape(group.id)}"]`)
    const viewport = root?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
    viewport?.scrollTo({ behavior: "auto", top: 0 })
  }

  return (
    <main className="relative h-full w-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background" data-active-review-group={group.id} data-review-mode={reviewMode}>
      <ScrollArea className="h-full" data-review-document key={group.id}>
        <div className="w-full min-w-0 max-w-none px-4 pb-5 pt-4 lg:px-6">
          <header>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-mono text-xs text-primary">Section {groupIndex + 1} of {totalGroups}</p>
                <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{group.title}</h1>
              </div>
              <Toggle
                aria-label={viewed ? "Clear all Normal and Guide review progress" : "Mark all Normal and Guide reviewed"}
                className={`shrink-0 rounded-md ${viewed ? "border-[var(--added)]/50! bg-[var(--added)]/10! text-[var(--added)]! hover:bg-[var(--added)]/15!" : ""}`}
                onPressedChange={(pressed) => {
                  if (pressed !== viewed) onToggleViewed()
                }}
                pressed={viewed}
                size="sm"
                variant="outline"
              >
                {viewed ? <Check className="text-[var(--added)]" /> : null}{viewed ? "Reviewed · Normal + Guide" : "Mark Normal + Guide reviewed"}
              </Toggle>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{group.summary}</p>
            <div className="mt-4 flex items-center gap-3">
              <span className="shrink-0 text-[11px] text-muted-foreground">{reviewStatus}</span>
              <Progress aria-label={`${group.title}: ${reviewStatus}`} className="max-w-[360px]" value={groupProgress} />
            </div>
            <Tabs className="mt-4" onValueChange={(value) => {
              if (value === "normal" || value === "guide") onSetReviewMode(value)
            }} value={reviewMode}>
              <TabsList aria-label="Reading mode" className="rounded-md" variant="default">
                <TabsTrigger className="rounded-sm px-3" value="normal">Normal</TabsTrigger>
                <TabsTrigger className="rounded-sm px-3" value="guide">Guide</TabsTrigger>
              </TabsList>
            </Tabs>
          </header>

          {inlineEvidence ? <div className="mt-4">{inlineEvidence}</div> : null}

          {reviewMode === "normal" && groupFiles.length > 0 ? (
            <>
              <div className="mb-2 mt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2"><FileDiff className="size-4 text-primary" /><h2 className="text-sm font-semibold" id="changed-files-heading">Changed files</h2></div>
                <div className="flex items-center gap-2">
                  {generatedFiles.length > 0 ? (
                    <Toggle
                      aria-label={showGeneratedFiles ? "Hide generated and binary files" : "Show generated and binary files"}
                      className="rounded-md"
                      onPressedChange={setShowGeneratedFiles}
                      pressed={showGeneratedFiles}
                      size="sm"
                      variant="outline"
                    >
                      <FileCog />{showGeneratedFiles ? "Hide generated/binary" : "Show generated/binary"}
                    </Toggle>
                  ) : null}
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
              </div>
              {treeFiles.length > 0 ? (
                <ChangedFileTree
                  className="mb-3"
                  files={treeFiles}
                  key={`${group.id}-${showGeneratedFiles ? "all" : "primary"}`}
                  onSelectedPathChange={onSelectedPathChange}
                  selectedPath={selectedPath}
                />
              ) : null}
              {primaryFiles.length > 0 ? <div className="pb-3">
                <SourceDiff
                  diffStyle={diffStyle}
                  evidence={group.files}
                  expandedPaths={expandedPaths}
                  files={primaryFiles}
                  key={`${group.id}-primary`}
                  onExpandedPathChange={onExpandedPathChange}
                  onToggleReviewed={onToggleFileReviewed}
                  reviewedPaths={reviewedPaths}
                />
              </div> : null}
              <GeneratedSourceDiff
                diffStyle={diffStyle}
                evidence={group.files}
                expandedPaths={expandedPaths}
                files={generatedFiles}
                key={`${group.id}-generated`}
                onExpandedPathChange={onExpandedPathChange}
                onToggleReviewed={onToggleFileReviewed}
                reviewedPaths={reviewedPaths}
              />
            </>
          ) : null}
          {reviewMode === "guide" ? (
            <GuideDocument
              diffStyle={diffStyle}
              expandedExcerptIds={expandedExcerptIds}
              group={group}
              groupFiles={groupFiles}
              onExpandedExcerptIdsChange={onExpandedExcerptIdsChange}
              onSetDiffStyle={onSetDiffStyle}
              onToggleExcerptReviewed={onToggleExcerptReviewed}
              reviewedExcerptIds={reviewedExcerptIds}
            />
          ) : null}
        </div>
      </ScrollArea>
      {showGoToTop ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button aria-label="Go to top" className="absolute right-4 bottom-4 z-30 size-11 bg-background/95 shadow-lg backdrop-blur-sm sm:size-8" onClick={scrollToTop} size="icon" variant="outline"><ArrowUpToLine /></Button>
          </TooltipTrigger>
          <TooltipContent side="left">Go to top</TooltipContent>
        </Tooltip>
      ) : null}
    </main>
  )
}
