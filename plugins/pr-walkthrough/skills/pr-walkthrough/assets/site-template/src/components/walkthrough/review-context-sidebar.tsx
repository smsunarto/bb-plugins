"use client"

import { useMemo } from "react"
import { ExternalLink, FileCode2, FileText } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { WalkthroughDiffFile, WalkthroughReviewGroup } from "@/data/walkthrough"
import { cn } from "@/lib/utils"

import { REVIEW_SURFACE_CLASS } from "./review-surface"

function isSpecPath(path: string) {
  return /(^|\/)(specs?|docs?)(\/|$)/i.test(path) || /(^|\/)(readme|product|tech)\.md$/i.test(path)
}

export function hasSupportingEvidence(
  group: WalkthroughReviewGroup,
  groupFiles: WalkthroughDiffFile[],
) {
  return groupFiles.some((file) => !file.generated && !file.binary && isSpecPath(file.path))
    || group.links.length > 0
    || group.comments.length > 0
}

type EvidenceRowsProps = {
  files: WalkthroughDiffFile[]
  icon: typeof FileCode2
  onOpenDiff: (path: string) => void
}

function EvidenceRows({ files, icon: Icon, onOpenDiff }: EvidenceRowsProps) {
  return (
    <ItemGroup className={cn(REVIEW_SURFACE_CLASS, "gap-0 divide-y")}>
      {files.map((file) => (
        <Item asChild className="border-0 hover:bg-muted" key={file.path} size="xs">
          <button
            data-file-path={file.path}
            onClick={() => onOpenDiff(file.path)}
            title={file.path}
            type="button"
          >
            <ItemMedia variant="icon">
              <Icon className="size-3.5 text-primary" />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="w-full truncate font-normal">
                {file.path.split("/").at(-1)}
              </ItemTitle>
            </ItemContent>
            <ItemActions className="shrink-0 gap-1.5 font-mono text-[10px]">
              <span className="text-[var(--added)]">+{file.additions}</span>
              <span className="text-[var(--deleted)]">−{file.deletions}</span>
            </ItemActions>
          </button>
        </Item>
      ))}
    </ItemGroup>
  )
}

type ReviewContextSidebarProps = {
  group: WalkthroughReviewGroup
  groupFiles: WalkthroughDiffFile[]
  inline?: boolean
  onOpenDiff: (path: string) => void
}

export function ReviewContextSidebar({
  group,
  groupFiles,
  inline = false,
  onOpenDiff,
}: ReviewContextSidebarProps) {
  const specs = useMemo(
    () => groupFiles.filter((file) => !file.generated && !file.binary && isSpecPath(file.path)),
    [groupFiles],
  )

  if (!hasSupportingEvidence(group, groupFiles)) return null

  const evidenceContent = (
    <div className={inline ? "space-y-4" : "space-y-4 p-4"}>
      {specs.length + group.links.length > 0 ? (
        <section className="space-y-2" aria-labelledby="related-evidence-heading">
          <h3 className="text-xs font-medium" id="related-evidence-heading">Relevant specs and links</h3>
          {specs.length > 0 ? <EvidenceRows files={specs} icon={FileText} onOpenDiff={onOpenDiff} /> : null}
          {group.links.map((link) => (
            <Button asChild className="w-full justify-between rounded-md" key={link.url} size="sm" variant="outline">
              <a href={link.url} rel="noreferrer" target="_blank"><span className="truncate">{link.label}</span><ExternalLink /></a>
            </Button>
          ))}
        </section>
      ) : null}

      {group.comments.length > 0 ? (
        <section className="space-y-2" aria-labelledby="review-notes-heading">
          <h3 className="text-xs font-medium" id="review-notes-heading">Existing review notes</h3>
          <ItemGroup className="gap-2">
            {group.comments.map((comment) => (
              <Item className={cn(REVIEW_SURFACE_CLASS, "items-start bg-muted/50")} key={`${comment.author}-${comment.body}`} size="xs">
                <ItemMedia className="text-primary" variant="icon"><FileText /></ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle>{comment.author}</ItemTitle>
                  <p className="text-xs/relaxed text-muted-foreground">{comment.body}</p>
                </ItemContent>
                {comment.url ? (
                  <ItemActions>
                    <Button asChild size="icon-xs" variant="ghost">
                      <a aria-label={`Open comment from ${comment.author}`} href={comment.url} rel="noreferrer" target="_blank" title="Open comment"><ExternalLink /></a>
                    </Button>
                  </ItemActions>
                ) : null}
              </Item>
            ))}
          </ItemGroup>
        </section>
      ) : null}
    </div>
  )

  if (inline) {
    return <aside aria-label="Supporting evidence" data-inline-evidence>{evidenceContent}</aside>
  }

  return (
    <aside className="h-full min-h-0 bg-card" aria-label="Supporting evidence">
      <ScrollArea className="h-full">{evidenceContent}</ScrollArea>
    </aside>
  )
}
