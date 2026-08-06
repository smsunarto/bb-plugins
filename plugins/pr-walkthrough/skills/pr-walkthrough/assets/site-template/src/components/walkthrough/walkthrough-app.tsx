"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, ExternalLink, GitBranch, PanelLeft, Search, Waypoints } from "lucide-react"

import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { walkthroughData, type WalkthroughDiffFile, type WalkthroughGuideExcerpt, type WalkthroughReviewGroup } from "@/data/walkthrough"

import type { ReviewDiffStyle } from "./diff-options"
import { hasSupportingEvidence, ReviewContextSidebar } from "./review-context-sidebar"
import { ReviewDocument, type ReviewMode } from "./review-document"
import { ReviewGroupRail } from "./review-group-rail"

function useDesktopWorkbench() {
  const [desktop, setDesktop] = useState(false)

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)")
    const update = () => setDesktop(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  return desktop
}

function groupFiles(group: WalkthroughReviewGroup, diffByPath: Map<string, WalkthroughDiffFile>) {
  return group.files.map((file) => diffByPath.get(file.path)).filter((file): file is WalkthroughDiffFile => Boolean(file))
}

function groupGuideExcerpts(group: WalkthroughReviewGroup): WalkthroughGuideExcerpt[] {
  return group.guide.phases.flatMap((phase) => phase.excerpts)
}

export function WalkthroughApp() {
  const groups = walkthroughData.reviewGroups
  const [activeGroupId, setActiveGroupId] = useState(groups[0]?.id ?? "")
  const [diffStyle, setDiffStyle] = useState<ReviewDiffStyle>("unified")
  const [reviewMode, setReviewMode] = useState<ReviewMode>("normal")
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | undefined>(walkthroughData.diffFiles[0]?.path)
  const [viewedGroups, setViewedGroups] = useState<Set<string>>(new Set())
  const [reviewedPaths, setReviewedPaths] = useState<Set<string>>(new Set())
  const [reviewedExcerptIds, setReviewedExcerptIds] = useState<Set<string>>(new Set())
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(
    walkthroughData.diffFiles.filter((file) => !file.generated).map((file) => file.path),
  ))
  const [expandedExcerptIds, setExpandedExcerptIds] = useState<Set<string>>(() => new Set(
    groups.flatMap(groupGuideExcerpts).filter((excerpt) => !excerpt.defaultCollapsed).map((excerpt) => excerpt.id),
  ))
  const [persistenceReady, setPersistenceReady] = useState(false)
  const [query, setQuery] = useState("")
  const [groupSheetOpen, setGroupSheetOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const desktop = useDesktopWorkbench()

  const diffByPath = useMemo(() => new Map(walkthroughData.diffFiles.map((file) => [file.path, file])), [])
  const activeGroupIndex = Math.max(0, groups.findIndex((group) => group.id === activeGroupId))
  const activeGroup = groups[activeGroupIndex] ?? groups[0]
  const activeGroupFiles = useMemo(() => activeGroup ? groupFiles(activeGroup, diffByPath) : [], [activeGroup, diffByPath])
  const activeGuideExcerpts = useMemo(() => activeGroup ? groupGuideExcerpts(activeGroup) : [], [activeGroup])
  const allGuideExcerpts = useMemo(() => groups.flatMap(groupGuideExcerpts), [groups])
  const validDiffPaths = useMemo(() => new Set(walkthroughData.diffFiles.map((file) => file.path)), [])
  const validExcerptIds = useMemo(() => new Set(allGuideExcerpts.map((excerpt) => excerpt.id)), [allGuideExcerpts])
  const storageKey = useMemo(
    () => `pr-walkthrough:v1:${walkthroughData.meta.prUrl || walkthroughData.meta.title}:${walkthroughData.meta.headSha}`,
    [],
  )
  const hasSupportingEvidenceContent = Boolean(
    activeGroup && hasSupportingEvidence(activeGroup, activeGroupFiles),
  )
  const resolvedViewedGroups = useMemo(() => {
    const next = new Set(viewedGroups)
    for (const group of groups) {
      const files = groupFiles(group, diffByPath)
      const requiredExcerpts = groupGuideExcerpts(group).filter((excerpt) => excerpt.countsTowardCompletion)
      const normalComplete = files.length > 0 && files.every((file) => reviewedPaths.has(file.path))
      const guideComplete = requiredExcerpts.length > 0 && requiredExcerpts.every((excerpt) => reviewedExcerptIds.has(excerpt.id))
      if (normalComplete || guideComplete) next.add(group.id)
      else next.delete(group.id)
    }
    return next
  }, [diffByPath, groups, reviewedExcerptIds, reviewedPaths, viewedGroups])
  const diffTotals = useMemo(() => walkthroughData.diffFiles.reduce(
    (totals, file) => ({ additions: totals.additions + file.additions, deletions: totals.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  ), [])

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey)
      if (stored) {
        const parsed = JSON.parse(stored) as {
          mode?: unknown
          reviewedPaths?: unknown
          reviewedExcerptIds?: unknown
        }
        if (parsed.mode === "normal" || parsed.mode === "guide") setReviewMode(parsed.mode)
        if (Array.isArray(parsed.reviewedPaths)) {
          setReviewedPaths(new Set(parsed.reviewedPaths.filter((path): path is string => typeof path === "string" && validDiffPaths.has(path))))
        }
        if (Array.isArray(parsed.reviewedExcerptIds)) {
          setReviewedExcerptIds(new Set(parsed.reviewedExcerptIds.filter((id): id is string => typeof id === "string" && validExcerptIds.has(id))))
        }
      }
    } catch {
      // Local progress is optional; storage may be disabled or contain stale data.
    } finally {
      setPersistenceReady(true)
    }
  }, [storageKey, validDiffPaths, validExcerptIds])

  useEffect(() => {
    if (!persistenceReady) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({
        mode: reviewMode,
        reviewedExcerptIds: [...reviewedExcerptIds].toSorted(),
        reviewedPaths: [...reviewedPaths].toSorted(),
      }))
    } catch {
      // The walkthrough remains usable when browser storage is unavailable.
    }
  }, [persistenceReady, reviewMode, reviewedExcerptIds, reviewedPaths, storageKey])

  const selectGroup = useCallback((groupId: string) => {
    const nextGroup = groups.find((group) => group.id === groupId)
    if (!nextGroup) return
    const nextGroupFiles = groupFiles(nextGroup, diffByPath)
    const initialFile = nextGroupFiles.find((file) => !file.generated) ?? nextGroupFiles[0]
    setActiveGroupId(groupId)
    setSelectedDiffPath(initialFile?.path)
    setGroupSheetOpen(false)
    window.requestAnimationFrame(() => {
      const viewport = document.querySelector<HTMLElement>('[data-review-document] [data-slot="scroll-area-viewport"]')
      viewport?.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
    })
  }, [diffByPath, groups])

  const moveGroup = useCallback((direction: -1 | 1) => {
    const nextIndex = Math.min(Math.max(activeGroupIndex + direction, 0), groups.length - 1)
    const nextGroup = groups[nextIndex]
    if (nextGroup) selectGroup(nextGroup.id)
  }, [activeGroupIndex, groups, selectGroup])

  const toggleViewed = useCallback(() => {
    if (!activeGroup) return
    const clearing = resolvedViewedGroups.has(activeGroup.id)
    setReviewedPaths((current) => {
      const next = new Set(current)
      for (const file of activeGroupFiles) {
        if (clearing) next.delete(file.path)
        else next.add(file.path)
      }
      return next
    })
    setReviewedExcerptIds((current) => {
      const next = new Set(current)
      for (const excerpt of activeGuideExcerpts) {
        if (clearing) next.delete(excerpt.id)
        else next.add(excerpt.id)
      }
      return next
    })
    setViewedGroups((current) => {
      const next = new Set(current)
      if (clearing) next.delete(activeGroup.id)
      else if (activeGroupFiles.length === 0 && activeGuideExcerpts.length === 0) next.add(activeGroup.id)
      return next
    })
  }, [activeGroup, activeGroupFiles, activeGuideExcerpts, resolvedViewedGroups])

  const toggleFileReviewed = useCallback((path: string) => {
    setReviewedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const toggleExcerptReviewed = useCallback((id: string) => {
    setReviewedExcerptIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const updateExpandedPaths = useCallback((paths: string[]) => {
    const activePaths = new Set(activeGroupFiles.map((file) => file.path))
    setExpandedPaths((current) => {
      const next = new Set(current)
      for (const path of activePaths) next.delete(path)
      for (const path of paths) next.add(path)
      return next
    })
  }, [activeGroupFiles])

  const updateExpandedExcerptIds = useCallback((ids: string[]) => {
    const activeIds = new Set(activeGuideExcerpts.map((excerpt) => excerpt.id))
    setExpandedExcerptIds((current) => {
      const next = new Set(current)
      for (const id of activeIds) next.delete(id)
      for (const id of ids) if (activeIds.has(id)) next.add(id)
      return next
    })
  }, [activeGuideExcerpts])

  const openInlineDiff = useCallback((path: string) => {
    setSelectedDiffPath(path)
    setExpandedPaths((current) => {
      if (current.has(path)) return current
      const next = new Set(current)
      next.add(path)
      return next
    })
    window.setTimeout(() => {
      const escapedPath = CSS.escape(path)
      document.querySelector<HTMLElement>(`[data-review-document] [data-diff-file-path="${escapedPath}"]`)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      })
    }, 220)
  }, [])

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable
      if (typing && event.key !== "Escape") return
      if (event.key === "/") {
        event.preventDefault()
        searchRef.current?.focus()
      } else if (event.key === "Escape") {
        setQuery("")
        searchRef.current?.blur()
      } else if (event.key === "ArrowRight" || event.key.toLowerCase() === "n") {
        moveGroup(1)
      } else if (event.key === "ArrowLeft" || event.key.toLowerCase() === "p") {
        moveGroup(-1)
      }
    }
    window.addEventListener("keydown", handleKeyboard)
    return () => window.removeEventListener("keydown", handleKeyboard)
  }, [moveGroup])

  if (!activeGroup) return null

  const evidence = hasSupportingEvidenceContent ? (
    <ReviewContextSidebar
      group={activeGroup}
      groupFiles={activeGroupFiles}
      inline={!desktop}
      onOpenDiff={openInlineDiff}
    />
  ) : null

  const guideDocument = (
    <ReviewDocument
      diffStyle={diffStyle}
      expandedExcerptIds={expandedExcerptIds}
      expandedPaths={expandedPaths}
      group={activeGroup}
      groupFiles={activeGroupFiles}
      groupIndex={activeGroupIndex}
      inlineEvidence={!desktop ? evidence : undefined}
      onExpandedExcerptIdsChange={updateExpandedExcerptIds}
      onExpandedPathsChange={updateExpandedPaths}
      onSelectedPathChange={openInlineDiff}
      onSetDiffStyle={setDiffStyle}
      onSetReviewMode={setReviewMode}
      onToggleExcerptReviewed={toggleExcerptReviewed}
      onToggleFileReviewed={toggleFileReviewed}
      onToggleViewed={toggleViewed}
      reviewMode={reviewMode}
      reviewedExcerptIds={reviewedExcerptIds}
      reviewedPaths={reviewedPaths}
      selectedPath={selectedDiffPath}
      totalGroups={groups.length}
      viewed={resolvedViewedGroups.has(activeGroup.id)}
    />
  )

  return (
    <div className="review-shell flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button aria-label="Open review groups" className="-ml-1 size-8 shrink-0 xl:hidden" onClick={() => setGroupSheetOpen(true)} size="icon-sm" variant="ghost"><PanelLeft /></Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Open review groups</TooltipContent>
        </Tooltip>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Waypoints className="size-4 shrink-0 text-primary" />
          <span className="hidden shrink-0 text-sm font-semibold sm:inline">PR walkthrough</span>
          <Separator className="hidden h-4 sm:block" orientation="vertical" />
          <span className="truncate text-sm text-muted-foreground">{walkthroughData.meta.title}</span>
        </div>
        <div className="hidden shrink-0 items-center gap-2 text-[11px] text-muted-foreground lg:flex">
          <GitBranch className="size-3.5" />
          <span className="font-mono">{walkthroughData.meta.baseRef}</span><ArrowLeft className="size-3" /><span className="max-w-44 truncate font-mono">{walkthroughData.meta.headRef}</span>
          <Separator className="mx-1 h-4" orientation="vertical" />
          <span>{walkthroughData.diffFiles.length} files</span>
          <span className="font-mono text-[var(--added)]">+{diffTotals.additions}</span>
          <span className="font-mono text-[var(--deleted)]">−{diffTotals.deletions}</span>
        </div>
        <InputGroup className="hidden h-8 w-[220px] shrink-0 lg:flex">
          <InputGroupAddon><Search /></InputGroupAddon>
          <InputGroupInput aria-label="Search review groups" onChange={(event) => setQuery(event.target.value)} placeholder="Search in PR" ref={searchRef} value={query} />
          <InputGroupAddon align="inline-end"><Kbd>/</Kbd></InputGroupAddon>
        </InputGroup>
        {walkthroughData.meta.prUrl ? <Button asChild className="shrink-0 rounded-md" size="sm"><a href={walkthroughData.meta.prUrl} rel="noreferrer" target="_blank">Open PR <ExternalLink /></a></Button> : null}
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {desktop ? (
          <ResizablePanelGroup className="h-full min-h-0" orientation="horizontal">
            <ResizablePanel className="min-w-0 overflow-hidden" defaultSize="20.7%" id="review-groups" maxSize="28%" minSize="240px">
              <ReviewGroupRail activeGroupId={activeGroup.id} diffByPath={diffByPath} groups={groups} onSelectGroup={selectGroup} query={query} viewedGroups={resolvedViewedGroups} />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel className="min-w-0 overflow-hidden" defaultSize={hasSupportingEvidenceContent ? "53.9%" : "79.3%"} id="review-document" minSize="560px">{guideDocument}</ResizablePanel>
            {hasSupportingEvidenceContent ? <ResizableHandle /> : null}
            {hasSupportingEvidenceContent ? (
              <ResizablePanel className="min-w-0 overflow-hidden" defaultSize="25.4%" id="review-evidence" maxSize="34%" minSize="320px">{evidence}</ResizablePanel>
            ) : null}
          </ResizablePanelGroup>
        ) : guideDocument}
      </div>

      <Sheet onOpenChange={setGroupSheetOpen} open={groupSheetOpen}>
        <SheetContent className="data-[side=left]:w-[min(92vw,22rem)] p-0" showCloseButton={false} side="left">
          <SheetHeader className="sr-only"><SheetTitle>Review groups</SheetTitle><SheetDescription>Select a logical change group.</SheetDescription></SheetHeader>
          <ReviewGroupRail activeGroupId={activeGroup.id} diffByPath={diffByPath} groups={groups} onClose={() => setGroupSheetOpen(false)} onSelectGroup={selectGroup} query={query} viewedGroups={resolvedViewedGroups} />
        </SheetContent>
      </Sheet>
    </div>
  )
}
