import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { experimental_Diff as Diff } from "@get-bb/plugin-sdk/app";
import type { Anchor } from "../shared/comments.ts";
import type { CanvasDocument } from "../shared/document.ts";
import type { Proposal } from "../shared/proposals.ts";
import {
  CommentsProvider,
  CommentsToolbar,
  Composer,
  ThreadCard,
  useComments,
} from "./comments.tsx";
import { quoteOffset, textIndex } from "./text-selection.ts";
import { rpc } from "./rpc.ts";
import { useCanvas } from "./state.tsx";

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
  const [selected, setSelected] = useState<{ anchor: Anchor; top: number; left: number } | null>(
    null,
  );
  const [composing, setComposing] = useState<Anchor | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const { tab, onTabChange: setTab } = props;
  const [open, setOpen] = useState(true);
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
      setComposing(anchor);
      setSelected(null);
      setOpen(true);
      setTab("comments");
    },
    [setTab],
  );
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
    const rect = range.getBoundingClientRect();
    setSelected({
      anchor,
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 150)),
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
      } else if (event.key === "Escape") {
        setSelected(null);
        setComposing(null);
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
    else
      requestAnimationFrame(() =>
        root.current
          ?.querySelector(`[data-thread-id="${CSS.escape(id)}"]`)
          ?.scrollIntoView({ block: "nearest" }),
      );
  }
  const allPlaced = [...comments.placement.byOffset.values()]
    .flat()
    .concat(comments.placement.detached);
  const edits = proposals.data?.file.proposals ?? [];
  const pendingEdits = edits.filter((p) => p.status === "pending" || p.status === "applying");
  return (
    <div className="canvas-review" ref={root}>
      <style>{`::highlight(${highlightName}) { background: color-mix(in srgb, var(--warning-text, var(--warning)) 28%, transparent); } ::highlight(${highlightName}-active) { background: color-mix(in srgb, var(--warning-text, var(--warning)) 48%, transparent); text-decoration: underline; }`}</style>
      <div className="canvas-review-toolbar">
        <span className="text-muted-foreground">Select text to comment · ⌘⇧M</span>
        <button
          type="button"
          className="canvas-review-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Review · {comments.openCount} {comments.openCount === 1 ? "comment" : "comments"} ·{" "}
          {pendingEdits.length} {pendingEdits.length === 1 ? "edit" : "edits"}
        </button>
      </div>
      <div className="canvas-review-layout" data-open={open}>
        <div
          className="canvas-review-document"
          onPointerUp={(event) => {
            selection();
            if (!window.getSelection()?.isCollapsed) return;
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
        {open && (
          <aside className="canvas-review-sidebar" aria-label="Canvas review">
            <div className="canvas-review-tabs" role="tablist" aria-label="Review">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "comments"}
                onClick={() => setTab("comments")}
              >
                Comments ({comments.openCount})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "edits"}
                onClick={() => setTab("edits")}
              >
                Suggested edits ({pendingEdits.length})
              </button>
            </div>
            {tab === "comments" ? (
              <section aria-label="Canvas comments">
                <div className="mb-3 flex flex-wrap gap-2 text-xs">
                  <CommentsToolbar />
                </div>
                {composing && (
                  <Composer
                    quote={composing.quote}
                    placeholder="Add a comment"
                    submitLabel="Comment"
                    onSubmit={(body) => {
                      comments.openSelection(composing, body);
                      setComposing(null);
                    }}
                    onCancel={() => setComposing(null)}
                  />
                )}
                {!comments.threads.length && !composing && (
                  <p className="canvas-review-empty">
                    Select a passage and choose Comment. Replies from you and your agent appear
                    here.
                  </p>
                )}
                {allPlaced
                  .filter(({ thread }) => comments.showResolved || thread.resolvedAtMs === null)
                  .map((placed) => (
                    <ThreadCard
                      key={placed.thread.id}
                      placed={
                        matched.has(placed.thread.id)
                          ? {
                              ...placed,
                              match: { kind: "anchored", offset: 0, index: 0, editedSince: false },
                            }
                          : placed
                      }
                      active={activeId === placed.thread.id}
                      onActivate={() => focusThread(placed.thread.id, true)}
                    />
                  ))}
              </section>
            ) : (
              <section aria-label="Suggested edits">
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
                    Your agent’s proposed changes appear here. Review and accept each edit
                    individually.
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
            )}
          </aside>
        )}
      </div>
      {selected && !composing && (
        <button
          type="button"
          className="canvas-review-selection canvas-review-button"
          style={{ top: selected.top, left: selected.left }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => beginComment(selected.anchor)}
        >
          Comment
        </button>
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
