import {
  cssIdentifier,
  scrollToReviewHeading as scrollOnly,
} from "../vendor/review/app/src/review-heading-scroll.ts";

export {
  cssIdentifier,
  getReviewScrollRoot,
} from "../vendor/review/app/src/review-heading-scroll.ts";

/**
 * Upstream's Contents jump, plus focus: the heading takes focus so the next
 * Tab continues in its section instead of the closed (hidden) Contents list.
 * Two frames let a collapsed section expand and scroll first (upstream scrolls
 * on the next frame). review-toc.tsx reaches this through a redirect row.
 */
export function scrollToReviewHeading(
  id: string,
  article: HTMLElement | null,
  scrollRegion: HTMLElement | null,
): void {
  scrollOnly(id, article, scrollRegion);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const heading = article?.querySelector<HTMLElement>(`#${cssIdentifier(id)}`);
      if (!heading) return;
      if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }),
  );
}
