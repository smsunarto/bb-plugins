"use client"

import { Check, FileCode2, ListTree, SearchX, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import type { WalkthroughDiffFile, WalkthroughReviewGroup } from "@/data/walkthrough"

const FILE_PREVIEW_LIMIT = 8

type ReviewGroupRailProps = {
  activeGroupId: string
  diffByPath: Map<string, WalkthroughDiffFile>
  groups: WalkthroughReviewGroup[]
  onClose?: () => void
  onSelectGroup: (groupId: string) => void
  query: string
  viewedGroups: Set<string>
}

export function ReviewGroupRail({ activeGroupId, diffByPath, groups, onClose, onSelectGroup, query, viewedGroups }: ReviewGroupRailProps) {
  const normalizedQuery = query.trim().toLowerCase()
  const visibleGroups = groups.filter((group) => {
    if (!normalizedQuery) return true
    return [group.title, group.summary, group.objective, ...group.files.map((file) => file.path)]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery)
  })

  return (
    <nav className="h-full min-h-0 bg-card" aria-label="Changes in pull request">
      <div className={`flex h-12 items-center justify-between gap-3 ${onClose ? "pl-4" : "px-4"}`}>
        <div className="flex items-center gap-2"><ListTree className="size-4 text-primary" /><h2 className="text-sm font-semibold">Changes in PR</h2></div>
        {onClose ? <Button aria-label="Close review groups" className="size-12 rounded-none" onClick={onClose} size="icon-sm" variant="ghost"><X /></Button> : null}
      </div>
      <Separator />
      <ScrollArea className="h-[calc(100%-3rem-1px)]">
        <ItemGroup className="gap-1.5 p-2">
          {visibleGroups.map((group, index) => {
            const active = activeGroupId === group.id
            const viewed = viewedGroups.has(group.id)
            const files = group.files.map((file) => diffByPath.get(file.path)).filter((file): file is WalkthroughDiffFile => Boolean(file))
            const orderedFiles = [
              ...files.filter((file) => !file.generated && !file.binary),
              ...files.filter((file) => file.generated || file.binary),
            ]
            const totals = files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 })
            return (
              <Item
                className={`cursor-pointer flex-col items-stretch gap-0 overflow-hidden rounded-md p-0 ${active ? "border-primary/60 bg-primary/8 shadow-sm" : "hover:bg-muted/50"}`}
                data-review-group-id={group.id}
                key={group.id}
                variant={active ? "outline" : "default"}
              >
                <button
                  aria-current={active ? "step" : undefined}
                  className="flex w-full items-start gap-3 px-3 py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  onClick={() => onSelectGroup(group.id)}
                  type="button"
                >
                  <ItemMedia
                    className={`mt-0.5 size-6 rounded-sm border font-mono text-[11px] ${active ? "border-primary bg-primary text-primary-foreground" : viewed ? "border-[var(--added)] text-[var(--added)]" : "text-muted-foreground"}`}
                    variant="icon"
                  >
                    {viewed ? <Check className="size-3.5" /> : index + 1}
                  </ItemMedia>
                  <ItemContent className="min-w-0 gap-0">
                    <div className="flex items-start justify-between gap-2">
                      <ItemTitle className="line-clamp-none text-[13px] leading-5">{group.title}</ItemTitle>
                      {viewed ? (
                        <ItemActions className="mt-0.5 shrink-0">
                          <Badge className="rounded-md border-[var(--added)]/50 text-[var(--added)]" variant="outline"><Check />Reviewed</Badge>
                        </ItemActions>
                      ) : null}
                    </div>
                    <ItemFooter className="mt-1 justify-start gap-2 font-mono text-[10px] text-muted-foreground">
                      <span>{files.length} files</span>
                      <span className="text-[var(--added)]">+{totals.additions}</span>
                      <span className="text-[var(--deleted)]">−{totals.deletions}</span>
                    </ItemFooter>
                    <ItemDescription className={`mt-2 leading-[18px] ${active ? "line-clamp-3" : "line-clamp-2"}`}>{group.summary}</ItemDescription>
                  </ItemContent>
                </button>
                {active && files.length > 0 ? (
                  <ItemGroup className="gap-0 border-t bg-background/35 px-2 py-1">
                    {orderedFiles.slice(0, FILE_PREVIEW_LIMIT).map((file) => (
                      <Item className="min-h-0 gap-1.5 border-0 px-1.5 py-1" key={file.path} size="xs">
                        <ItemMedia className="size-4" variant="icon"><FileCode2 className="size-3 text-muted-foreground" /></ItemMedia>
                        <ItemContent className="min-w-0">
                          <ItemTitle className="block truncate font-mono text-[11px] font-normal leading-4">{file.path.split("/").at(-1)}</ItemTitle>
                        </ItemContent>
                      </Item>
                    ))}
                    {orderedFiles.length > FILE_PREVIEW_LIMIT ? (
                      <Item className="min-h-0 border-0 px-1.5 py-1 font-mono text-[10px] font-normal text-muted-foreground" size="xs">
                        +{orderedFiles.length - FILE_PREVIEW_LIMIT} more files
                      </Item>
                    ) : null}
                  </ItemGroup>
                ) : null}
              </Item>
            )
          })}
          {visibleGroups.length === 0 ? (
            <Empty className="min-h-32 gap-2 p-4">
              <EmptyHeader>
                <EmptyMedia className="mb-0" variant="icon"><SearchX /></EmptyMedia>
                <EmptyTitle>No matching review groups</EmptyTitle>
                <EmptyDescription>No group matches “{query}”.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
        </ItemGroup>
      </ScrollArea>
    </nav>
  )
}
