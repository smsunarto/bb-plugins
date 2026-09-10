import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { experimental_Diff as Diff } from "@get-bb/plugin-sdk/app";
import type { Anchor } from "../shared/comments.ts";
import type { CanvasDocument } from "../shared/document.ts";
import type { Proposal } from "../shared/proposals.ts";
import {
  CommentsProvider,
  CommentsToolbar,
  Composer,
  CommentIcon,
  MarginThread,
  useComments,
} from "./comments.tsx";
import { quoteOffset, textIndex } from "./text-selection.ts";
import { rpc } from "./rpc.ts";
import { useCanvas } from "./state.tsx";
import { SelectionActions, type ReviewSelection } from "./selection-actions.tsx";
import { ReviewTabs } from "./review-tabs.tsx";
import { CommentMargin } from "./comment-margin.tsx";

export interface CanvasReviewProps {
  tab: "comments" | "edits";
  onTabChange(tab: "comments" | "edits"): void;
  markdown: string;
  children: ReactNode;
  onApplied(result: { content: string; sha256: string }): void;
  onApplying(value: boolean): void;
}

function proposalPatch(proposal: Proposal): string {
  const before = proposal.before.split("\n");
  const after = proposal.after.split("\n");
  return `--- a/canvas.mdx\n+++ b/canvas.mdx\n@@ -1,${before.length} +1,${after.length} @@\n${before.map((line) => `-${line}`).join("\n")}\n${after.map((line) => `+${line}`).join("\n")}\n`;
}

function ProposalCard({
  proposal,
  pending,
  onDecide,
}: {
  proposal: Proposal;
  pending: boolean;
  onDecide(proposal: Proposal, decision: "accept" | "reject"): void;
}) {
  const applying = proposal.status === "applying";
  return (
    <article className="canvas-proposal">
      <div className="font-medium">{proposal.title}</div>
      <div className="mb-2 text-xs text-muted-foreground">
        {proposal.author === "agent" ? "Agent" : "You"} · {proposal.status}
      </div>
      <Diff patch={proposalPatch(proposal)} path="canvas.mdx" view="unified" />
      {(proposal.status === "pending" || applying) && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className="canvas-review-button"
            disabled={pending}
            onClick={() => onDecide(proposal, "accept")}
          >
            {applying ? "Finish accepting" : "Accept"}
          </button>
          <button
            type="button"
            className="canvas-review-button"
            disabled={pending || applying}
            onClick={() => onDecide(proposal, "reject")}
          >
            Reject
          </button>
        </div>
      )}
    </article>
  );
}

function ReviewPane(props: CanvasReviewProps & { document: CanvasDocument }) {
  const comments = useComments();
  const { source } = useCanvas();
  const root = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<ReviewSelection | null>(null);
  const [composing, setComposing] = useState<Anchor | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const { tab, onTabChange: setTab } = props;
  const [open, setOpen] = useState(false);
  const openedForContent = useRef(false);
  const [showDecided, setShowDecided] = useState(false);
  const [matched, setMatched] = useState<ReadonlySet<string>>(new Set());
  const highlightName = `canvas-comments-${useId().replace(/[^a-z0-9]/gi, "")}`;
  const ranges = useRef(new Map<string, Range>());
  const proposals = rpc.proposals.useQuery(
    { source },
    { refetchInterval: 1500, refetchOnWindowFocus: true },
  );
  const decide = rpc.decide.useMutation({
    onSuccess(result, input) {
      if (input.decision === "accept") props.onApplied(result);
      void proposals.refetch();
    },
    onSettled() {
      props.onApplying(false);
    },
  });
  const handleDecision = (proposal: Proposal, decision: "accept" | "reject") => {
    props.onApplying(true);
    decide.mutate({ source, proposal, decision, expectedContent: props.markdown });
  };
  const beginComment = useCallback(
    (anchor: Anchor) => {
      openedForContent.current = true;
      // Resume an unfinished comment without silently moving it to a new quote.
      if (!composing) setComposing(anchor);
      setSelected(null);
      setActiveId(null);
      window.getSelection()?.removeAllRanges();
      setOpen(true);
      setTab("comments");
      if (composing)
        requestAnimationFrame(() =>
          root.current
            ?.querySelector<HTMLTextAreaElement>(".canvas-comment-composer textarea")
            ?.focus(),
        );
    },
    [setTab, composing],
  );
  const closeReview = () => {
    openedForContent.current = true;
    setOpen(false);
    root.current
      ?.querySelector<HTMLButtonElement>(".canvas-review-toolbar button")
      ?.focus({ preventScroll: true });
  };
  const selection = useCallback(() => {
    const editor = root.current?.querySelector<HTMLElement>(".docs-prose");
    const current = window.getSelection();
    if (!editor || !current || current.isCollapsed || !current.rangeCount) {
      setSelected(null);
      return null;
    }
    const range = current.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
      setSelected(null);
      return null;
    }
    const index = textIndex(editor);
    const start = index.offset(range.startContainer, range.startOffset);
    const end = index.offset(range.endContainer, range.endOffset);
    if (start === null || end === null || start === end) {
      setSelected(null);
      return null;
    }
    const quote = index.text.slice(start, end);
    if (!quote.trim()) {
      setSelected(null);
      return null;
    }
    const anchor: Anchor = {
      quote,
      prefix: index.text.slice(Math.max(0, start - 48), start),
      suffix: index.text.slice(end, end + 48),
    };
    setSelected({
      anchor,
      range,
      editor,
      backward:
        current.focusNode === range.startContainer && current.focusOffset === range.startOffset,
    });
    return anchor;
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "m") {
        const anchor = selection();
        if (anchor) {
          event.preventDefault();
          beginComment(anchor);
        }
      } else if (event.key === "Escape" && root.current?.contains(event.target as Node)) {
        setSelected(null);
        if (event.target instanceof Element && event.target.closest(".canvas-comment-margin-item"))
          setActiveId(null);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("selectionchange", selection);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("selectionchange", selection);
    };
  }, [selection, beginComment]);

  useEffect(() => {
    const editor = root.current?.querySelector<HTMLElement>(".docs-prose");
    if (!editor) return;
    const refresh = () => {
      const index = textIndex(editor);
      const next = new Map<string, Range>();
      for (const thread of comments.threads) {
        if (thread.resolvedAtMs !== null && !comments.showResolved) continue;
        const anchor = thread.anchor;
        const at = quoteOffset(index.text, anchor);
        if (at === null || !anchor.quote) continue;
        const range = index.range(at, anchor.quote.length);
        if (range) next.set(thread.id, range);
      }
      ranges.current = next;
      setMatched(new Set(next.keys()));
      if (typeof Highlight !== "undefined" && CSS.highlights) {
        CSS.highlights.set(
          highlightName,
          new Highlight(
            ...next.values(),
            ...(composing
              ? (() => {
                  const at = quoteOffset(index.text, composing);
                  const range =
                    at !== null && composing.quote ? index.range(at, composing.quote.length) : null;
                  return range ? [range] : [];
                })()
              : []),
          ),
        );
        const active = activeId ? next.get(activeId) : undefined;
        CSS.highlights.set(`${highlightName}-active`, new Highlight(...(active ? [active] : [])));
      }
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(editor, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      globalThis.CSS?.highlights?.delete(highlightName);
      globalThis.CSS?.highlights?.delete(`${highlightName}-active`);
    };
  }, [comments.threads, comments.showResolved, composing, activeId, highlightName, props.markdown]);

  function focusThread(id: string, scrollText: boolean) {
    setActiveId(id);
    setOpen(true);
    setTab("comments");
    if (scrollText)
      ranges.current
        .get(id)
        ?.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  const allPlaced = [...comments.placement.byOffset.values()]
    .flat()
    .concat(comments.placement.detached);
  const edits = proposals.data?.file.proposals ?? [];
  const pendingEdits = edits.filter((p) => p.status === "pending" || p.status === "applying");
  useEffect(() => {
    if (!openedForContent.current && (comments.threads.length > 0 || edits.length > 0)) {
      openedForContent.current = true;
      setOpen(true);
    }
  }, [comments.threads.length, edits.length]);
  return (
    <div className="canvas-review" ref={root}>
      <style>{`::highlight(${highlightName}) { background: color-mix(in srgb, var(--warning-text, var(--warning)) 28%, transparent); text-decoration: underline; text-decoration-color: var(--warning-text, var(--warning)); } ::highlight(${highlightName}-active) { background: color-mix(in srgb, var(--warning-text, var(--warning)) 48%, transparent); text-decoration: underline; }`}</style>
      <div className="canvas-review-toolbar">
        <span className="canvas-review-hint">
          Select text to comment <kbd>⌘⇧M</kbd>
        </span>
        <div className="canvas-review-controls" hidden={!open}>
          <div className="canvas-review-sidebar-heading">
            <button
              type="button"
              className="canvas-review-icon-button"
              aria-label="Close review"
              title="Close review"
              onClick={closeReview}
            >
              <svg
                viewBox="0 0 16 16"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
          <ReviewTabs
            id={highlightName}
            tab={tab}
            onTabChange={setTab}
            commentCount={comments.openCount}
            editCount={pendingEdits.length}
          />
        </div>
        <button
          type="button"
          className="canvas-review-button"
          aria-expanded={open}
          aria-label={`Review · ${comments.openCount} comments · ${pendingEdits.length} edits`}
          onClick={() => {
            openedForContent.current = true;
            setOpen(!open);
          }}
        >
          <CommentIcon /> Review
          {composing && <span className="canvas-review-count">Draft</span>}
          {comments.openCount + pendingEdits.length > 0 && (
            <span className="canvas-review-count">{comments.openCount + pendingEdits.length}</span>
          )}
        </button>
      </div>
      <div
        className="canvas-review-layout"
        data-open={open}
        data-tab={tab}
        data-expanded={Boolean(composing || activeId || tab === "edits")}
      >
        <div
          className="canvas-review-document"
          onPointerUp={(event) => {
            selection();
            if (!window.getSelection()?.isCollapsed) return;
            setActiveId(null);
            for (const [id, range] of ranges.current) {
              if (
                [...range.getClientRects()].some(
                  (rect) =>
                    event.clientX >= rect.left &&
                    event.clientX <= rect.right &&
                    event.clientY >= rect.top &&
                    event.clientY <= rect.bottom,
                )
              ) {
                focusThread(id, false);
                break;
              }
            }
          }}
        >
          {props.children}
        </div>
        <aside
          className="canvas-review-sidebar"
          data-tab={tab}
          aria-label="Canvas review"
          hidden={!open}
        >
          <section
            id={`${highlightName}-comments`}
            role="tabpanel"
            aria-labelledby={`${highlightName}-comments-tab`}
            hidden={tab !== "comments"}
          >
            <div className="mb-3 flex flex-wrap gap-2 text-xs">
              <CommentsToolbar />
            </div>
            {!comments.threads.length && !composing && (
              <p className="canvas-review-empty">
                <CommentIcon />
                <strong>No comments yet</strong>
                <span>Select a passage to start a conversation.</span>
              </p>
            )}
            <CommentMargin
              documentRef={root}
              onDismiss={(id) => (id === "draft" ? closeReview() : setActiveId(null))}
              visible={open && tab === "comments"}
              items={[
                ...(composing
                  ? [
                      {
                        id: "draft",
                        minimized: false,
                        anchor: composing,
                        content: (
                          <Composer
                            compact
                            quote={null}
                            placeholder="Add a comment"
                            submitLabel="Comment"
                            onSubmit={(body) => {
                              const id = comments.openSelection(composing, body);
                              setComposing(null);
                              focusThread(id, false);
                            }}
                            onCancel={() => setComposing(null)}
                            onEscape={closeReview}
                          />
                        ),
                      },
                    ]
                  : []),
                ...allPlaced
                  .filter(({ thread }) => comments.showResolved || thread.resolvedAtMs === null)
                  .map((placed) => ({
                    id: placed.thread.id,
                    minimized: activeId !== placed.thread.id,
                    anchor: placed.thread.anchor,
                    content: (
                      <MarginThread
                        placed={
                          matched.has(placed.thread.id)
                            ? {
                                ...placed,
                                match: {
                                  kind: "anchored",
                                  offset: 0,
                                  index: 0,
                                  editedSince: false,
                                },
                              }
                            : placed
                        }
                        active={activeId === placed.thread.id}
                        onActivate={() => setActiveId(placed.thread.id)}
                        onMinimize={() => setActiveId(null)}
                      />
                    ),
                  })),
              ]}
            />
          </section>
          <section
            id={`${highlightName}-edits`}
            role="tabpanel"
            aria-labelledby={`${highlightName}-edits-tab`}
            hidden={tab !== "edits"}
          >
            {proposals.error && (
              <p role="alert" className="text-destructive">
                {proposals.error.message}
              </p>
            )}
            {decide.error && (
              <p role="alert" className="text-destructive">
                {decide.error.message}
              </p>
            )}
            {!edits.length && (
              <p className="canvas-review-empty">
                <strong>No suggested edits</strong>
                <span>Your agent’s changes will appear here for review.</span>
              </p>
            )}
            {edits.some((p) => p.status === "accepted" || p.status === "rejected") && (
              <button
                type="button"
                className="canvas-review-button"
                onClick={() => setShowDecided(!showDecided)}
              >
                {showDecided ? "Hide reviewed" : "Show reviewed"}
              </button>
            )}
            {(showDecided ? edits : pendingEdits).map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                pending={decide.isPending}
                onDecide={handleDecision}
              />
            ))}
          </section>
        </aside>
      </div>
      {selected && (
        <SelectionActions
          selection={selected}
          resume={Boolean(composing)}
          onComment={beginComment}
          onDismiss={() => setSelected(null)}
        />
      )}
    </div>
  );
}

export function CanvasReviewBody(props: CanvasReviewProps & { document: CanvasDocument }) {
  return (
    <CommentsProvider document={props.document} pollIntervalMs={1500} sidebar>
      <ReviewPane {...props} />
    </CommentsProvider>
  );
}
