import type { ReactNode, RefObject } from "react";

/** One scroll area keeps the overview mounted while files load, fail, or refresh. */
export function ReviewLayout({
  hasFiles,
  scroller,
  overview,
  rail,
  toolbar,
  notices,
  children,
}: {
  hasFiles: boolean;
  scroller: RefObject<HTMLDivElement | null>;
  overview: ReactNode;
  rail: ReactNode;
  toolbar: ReactNode;
  notices: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-review-layout className="@container/changes min-h-0 min-w-0 flex-1">
      <div className="flex h-full min-h-0 min-w-0 flex-col @3xl/changes:flex-row">
        {hasFiles ? rail : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {hasFiles ? toolbar : null}
          {notices}
          <div
            ref={scroller}
            data-cr-scroll
            className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
          >
            {overview ? (
              <div data-cr-section="summary" className="border-b border-border p-3 pb-5">
                {overview}
              </div>
            ) : null}
            <div data-cr-section="changes" className="px-3 pt-4 pb-2">
              <h2 className="text-xs font-semibold text-foreground">Changes</h2>
            </div>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
