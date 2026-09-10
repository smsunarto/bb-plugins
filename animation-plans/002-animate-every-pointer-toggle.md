# 002 — Animate every pointer-initiated open, close and switch, and slide displaced neighbors

- **Status**: DONE (applied 2026-09-10, verified in isolated bb run motion-20260910-1530)
- **Commit**: 15b60592 (GitButler commit `xzm` on `scott/canvas-review`; workspace head 9b8e63b7)
- **Severity**: HIGH
- **Category**: 1 Purpose & frequency / 4 Interruptibility (spatial consistency; also 8 Missed opportunity for the neighbor slide)
- **Estimated scope**: 1 file (`plugins/canvas/src/app/comment-margin.tsx`), ~90 lines changed. No change to `review.tsx`.

## Problem

Only two pointer paths animate: clicking the avatar (`.canvas-comment-marker`) and
clicking the floating × (`.canvas-comment-float-close`). Both are caught by
`onClickCapture` on the rail (`comment-margin.tsx:199-226`), which records one
`PointerOrigin`. Every other pointer-driven toggle snaps:

1. **Clicking the highlighted passage** in the document opens the card instantly.
   `review.tsx:321-339` (`onPointerUp` on `.canvas-review-document`) calls
   `focusThread(id, false)` → `setActiveId(id)`. The rail's click capture never
   sees it, so no origin is recorded and `animateToggle` is skipped. This is the
   most natural way to open a comment, and it is the one path with no motion.
2. **Clicking anywhere else in the document** while a card is open collapses it
   instantly (same handler, `setActiveId(null)` at `review.tsx:324`).
3. **Switching threads** (clicking avatar B while A is open) grows B from its avatar
   but A teleports back into its avatar: the capture records only B's origin.
4. **Starting a draft** from the selection popover (`SelectionActions`, a Radix
   portal outside the rail) minimizes the open card instantly via
   `beginComment` → `setActiveId(null)` (`review.tsx:114`).
5. **Neighbors jump.** When a card opens in the overlay layout, `layout()` pushes
   any avatar it would overlap to `previous.bottom + 10` (`comment-margin.tsx:149-160`)
   by setting `element.style.transform` with no transition. The displaced avatars
   teleport, then teleport back on close.

Additional robustness issues in the same code:

- `pointerOrigin` is never cleared when `visible` turns false
  (`comment-margin.tsx:105` returns before line 174), so a stale origin and its
  cloned DOM survive until the next visible render.
- The snapshot is `cloneNode(true)` (`comment-margin.tsx:214`). Cloning copies a
  textarea's initial text, not its current value, so the collapsing snapshot of a
  card with an unsent reply shows an empty "Reply" field.

Current code (the parts that change):

```ts
// plugins/canvas/src/app/comment-margin.tsx:24-31 — current
interface PointerOrigin {
  id: string;
  minimized: boolean;
  rect: DOMRect;
  width: number;
  height: number;
  snapshot: HTMLElement;
}
```

```ts
// plugins/canvas/src/app/comment-margin.tsx:98-105 — current
const margin = useRef<HTMLDivElement>(null);
const pointerOrigin = useRef<PointerOrigin | null>(null);
const motion = useRef<Animation | null>(null);
useLayoutEffect(() => () => motion.current?.cancel(), []);
useLayoutEffect(() => {
  const rail = margin.current;
  const editor = documentRef.current?.querySelector<HTMLElement>(".docs-prose");
  if (!rail || !editor || !visible) return;
```

```ts
// plugins/canvas/src/app/comment-margin.tsx:171-174 — current
layout();
if (pointerOrigin.current)
  motion.current = animateToggle(rail, items, pointerOrigin.current) ?? null;
pointerOrigin.current = null;
```

```tsx
// plugins/canvas/src/app/comment-margin.tsx:191-227 — current
return (
  <div
    className="canvas-comment-margin"
    ref={margin}
    onKeyDownCapture={() => {
      pointerOrigin.current = null;
      motion.current?.cancel();
    }}
    onClickCapture={(event) => {
      pointerOrigin.current = null;
      if (!event.detail || !(event.target instanceof Element)) return;
      const trigger = event.target.closest(".canvas-comment-marker, .canvas-comment-float-close");
      const item = trigger?.closest<HTMLElement>(".canvas-comment-margin-item");
      const surface = item?.querySelector<HTMLElement>(".canvas-comment-motion");
      if (!item?.dataset.marginId || !surface) return;
      const animated = (motion.current?.effect as KeyframeEffect | null)?.target;
      const visibleSurface =
        motion.current?.playState === "running" &&
        animated instanceof HTMLElement &&
        animated.parentElement === item
          ? animated
          : surface;
      const rect = visibleSurface.getBoundingClientRect();
      const snapshot = visibleSurface.cloneNode(true) as HTMLElement;
      const width = visibleSurface.offsetWidth;
      const height = visibleSurface.offsetHeight;
      motion.current?.cancel();
      pointerOrigin.current = {
        id: item.dataset.marginId,
        minimized: item.dataset.minimized === "true",
        rect,
        width,
        height,
        snapshot,
      };
    }}
  >
```

## Target

Replace "record the origin of the one element that was clicked" with "record the
origin of every margin item on any pointer release, then animate whatever changed".

- A capture-phase `pointerup` listener on `document` (only while `visible`) snapshots
  every margin item: its id, minimized flag, the current visual rect of its surface
  (or of its in-flight animated element), and, for expanded items only, a DOM clone
  with live textarea values copied in. Stamp the capture with `performance.now()`.
- A capture-phase `keydown` listener on `document` clears the captured origins and
  cancels running motions, so keyboard-initiated toggles stay instant (settled
  requirement) even if a pointer release happened moments before.
- In the layout effect, after `layout()`: if origins exist and are younger than
  500 ms, for each origin whose item still exists:
  - minimized flag changed → cancel that item's running motion, call the existing
    `animateToggle` (unchanged signature), store the returned animation per id;
  - minimized flag unchanged and the surface moved by ≥ 1px → animate the surface
    from its old position to its new one: `translate(dx, dy)` → `translate(0, 0)`,
    200 ms, `--canvas-comment-motion-ease`, `fill: "none"`. Skip if that item has a
    running motion.
- Origins are always consumed (set to null) by the effect, and cleared plus all
  motions cancelled when `visible` is false or on unmount.
- `motion: Animation | null` becomes `motions: Map<string, Animation>` so A's collapse
  and B's expand can run concurrently.
- `review.tsx` is untouched. The document `onPointerUp` and the popover "Comment"
  button both dispatch after the capture-phase `pointerup`, in the same task, so the
  origins are fresh when React commits.
- Reduced motion: `animateToggle` already returns early; the neighbor slide must
  also return early under `(prefers-reduced-motion: reduce)`.

## Repo conventions to follow

- Motion tool is WAAPI on `.canvas-comment-motion`; the item div's `transform` is
  owned by `layout()` and must never be animated (it is the anchor position).
  Exemplar: `animateToggle` (`comment-margin.tsx:65-78`) animates the surface only.
- Easing is read from the rail's CSS custom property
  (`getComputedStyle(rail).getPropertyValue("--canvas-comment-motion-ease").trim()`).
- Listeners registered in the layout effect are removed in its cleanup, next to the
  existing `window.addEventListener("resize", schedule)` and
  `document.addEventListener("scroll", schedule, true)` (`comment-margin.tsx:181-188`).
- Short intent comments in prose, matching the file.

## Steps

1. Replace the `PointerOrigin` interface (`comment-margin.tsx:24-31`) with:

   ```ts
   interface PointerOrigin {
     id: string;
     minimized: boolean;
     rect: DOMRect;
     width: number;
     height: number;
     snapshot: HTMLElement | null;
   }

   /** Where every conversation was when the pointer was released, so a toggle can start there. */
   interface PointerOrigins {
     at: number;
     byId: Map<string, PointerOrigin>;
   }

   const ORIGIN_TTL_MS = 500;
   ```

2. In `animateToggle`, change the target line so a missing snapshot aborts a collapse:

   ```ts
   // before
   const target = item.minimized ? previous.snapshot : surface;
   // after
   const target = item.minimized ? previous.snapshot : surface;
   if (!target) return;
   ```

3. Add two helpers below `animateToggle` (before `export function CommentMargin`):

   ```ts
   function captureOrigins(rail: HTMLElement, motions: Map<string, Animation>): PointerOrigins {
     const byId = new Map<string, PointerOrigin>();
     for (const child of rail.children) {
       const item = child as HTMLElement;
       const id = item.dataset.marginId;
       const surface = item.querySelector<HTMLElement>(".canvas-comment-motion");
       if (!id || !surface) continue;
       const running = motions.get(id);
       const animated = (running?.effect as KeyframeEffect | null)?.target;
       // A card mid-flight is measured where it visually is, not where React laid it out.
       const visible =
         running?.playState === "running" &&
         animated instanceof HTMLElement &&
         animated.parentElement === item
           ? animated
           : surface;
       const minimized = item.dataset.minimized === "true";
       let snapshot: HTMLElement | null = null;
       if (!minimized) {
         snapshot = visible.cloneNode(true) as HTMLElement;
         // cloneNode copies a textarea's initial text, not what the user has typed since.
         const fields = visible.querySelectorAll("textarea");
         snapshot.querySelectorAll("textarea").forEach((field, index) => {
           field.value = fields[index]?.value ?? "";
         });
       }
       byId.set(id, {
         id,
         minimized,
         rect: visible.getBoundingClientRect(),
         width: visible.offsetWidth,
         height: visible.offsetHeight,
         snapshot,
       });
     }
     return { at: performance.now(), byId };
   }

   /** A conversation that kept its state but was pushed aside slides instead of jumping. */
   function animateShift(rail: HTMLElement, previous: PointerOrigin) {
     if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
     const element = Array.from(rail.children).find(
       (child) => (child as HTMLElement).dataset.marginId === previous.id,
     );
     const surface = element?.querySelector<HTMLElement>(".canvas-comment-motion");
     if (!surface) return;
     const next = surface.getBoundingClientRect();
     const dx = previous.rect.left - next.left;
     const dy = previous.rect.top - next.top;
     if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
     return surface.animate(
       [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }],
       {
         duration: 200,
         fill: "none",
         easing: getComputedStyle(rail).getPropertyValue("--canvas-comment-motion-ease").trim(),
       },
     );
   }
   ```

4. Replace the refs and the two `useLayoutEffect` openings (`comment-margin.tsx:98-105`) with:

   ```ts
   const margin = useRef<HTMLDivElement>(null);
   const pointerOrigins = useRef<PointerOrigins | null>(null);
   const motions = useRef(new Map<string, Animation>());
   const cancelMotions = () => {
     for (const animation of motions.current.values()) animation.cancel();
     motions.current.clear();
   };
   useLayoutEffect(() => cancelMotions, []);
   useLayoutEffect(() => {
     const rail = margin.current;
     const editor = documentRef.current?.querySelector<HTMLElement>(".docs-prose");
     if (!rail || !editor || !visible) {
       pointerOrigins.current = null;
       cancelMotions();
       return;
     }
   ```

5. Replace the block after `layout();` (`comment-margin.tsx:171-174`) with:

   ```ts
   layout();
   const origins = pointerOrigins.current;
   pointerOrigins.current = null;
   if (origins && performance.now() - origins.at < ORIGIN_TTL_MS) {
     for (const origin of origins.byId.values()) {
       const item = items.find((candidate) => candidate.id === origin.id);
       if (!item) continue;
       if (item.minimized !== origin.minimized) {
         motions.current.get(origin.id)?.cancel();
         const animation = animateToggle(rail, items, origin);
         if (animation) motions.current.set(origin.id, animation);
       } else if (motions.current.get(origin.id)?.playState !== "running") {
         const animation = animateShift(rail, origin);
         if (animation) motions.current.set(origin.id, animation);
       }
     }
   }
   ```

6. Register the document listeners inside the same effect, next to the existing
   `window.addEventListener("resize", schedule);` line, and remove them in the cleanup:

   ```ts
   // Pointer releases may become a toggle a moment later (click, or the document's pointerup).
   // Remember where everything is now; keyboard actions stay instant, so a key press forgets it.
   const remember = () => {
     pointerOrigins.current = captureOrigins(rail, motions.current);
   };
   const forget = () => {
     pointerOrigins.current = null;
     cancelMotions();
   };
   document.addEventListener("pointerup", remember, true);
   document.addEventListener("keydown", forget, true);
   ```

   and in the returned cleanup:

   ```ts
   document.removeEventListener("pointerup", remember, true);
   document.removeEventListener("keydown", forget, true);
   ```

7. Remove `onKeyDownCapture` and `onClickCapture` from the rail `<div>` entirely
   (`comment-margin.tsx:195-226`). The JSX becomes:

   ```tsx
   <div className="canvas-comment-margin" ref={margin}>
   ```

8. Remove the now-unused `motion` ref and the `pointerOrigin` ref if any reference
   remains (typecheck will tell you).

## Boundaries

- Do NOT touch `review.tsx`, `comments.tsx`, `app.css`, or the Docs plugin. The
  point of this plan is that all toggles already flow through `items[].minimized`.
- Do NOT animate the margin item's own `style.transform` (owned by `layout()`).
- Do NOT change `animateToggle`'s keyframes, duration, or easing; if plan 001 has
  already been applied, keep its companion animations as they are.
- Do NOT add dependencies.
- If the excerpts above do not match the file (drift since commit 15b60592), STOP
  and report instead of improvising.

## Verification

- **Mechanical**:
  ```sh
  cd plugins/canvas && bun run typecheck && bunx oxlint src/app/comment-margin.tsx && bun test
  cd ../docs && bun run typecheck && bun run test
  ```
  Expected: all clean. Docs has 84 tests today; none should change.
- **Feel check** (Docs, a `.canvas.mdx` with three comments on nearby lines, pane
  narrower than 760px):
  - Click the highlighted passage: the card grows from its avatar exactly as it
    does when clicking the avatar.
  - With a card open, click plain text elsewhere in the document: the card shrinks
    back into its avatar (previously it vanished).
  - With A open, click avatar B: A shrinks into its avatar while B grows, at the
    same time, both 200 ms.
  - With A open, select text and click "Comment" in the popover: A shrinks into its
    avatar while the draft appears.
  - Open a card that overlaps another avatar: the displaced avatar slides to its
    new spot (200 ms, same ease) rather than jumping, and slides back on close.
  - Type a reply, click ×, reopen: the reply text is still there, and during the
    collapse the shrinking snapshot shows the typed text rather than an empty field.
  - Keyboard: focus an avatar and press Enter, then Escape: both instant. Press ⌘⇧M
    with a selection right after a mouse click: the open card collapses instantly.
  - Spam-click avatar/×/passage: never more than one surface visible per thread,
    every retarget starts from the current visual bounds (DevTools > Animations at
    10% playback).
  - Reduced motion: all of the above are instant swaps.
  - Wide pane (>760px): repeat the first three checks; the card travels between the
    avatar over the text and the sidebar column as it does today.
- **Done when**: every feel check passes and typecheck/lint/tests are clean in both
  plugins.
