# 001 — Morph the avatar circle into the card and hide card content while it is squashed

- **Status**: DONE (applied 2026-09-10, verified in isolated bb run motion-20260910-1530)
- **Commit**: 15b60592 (GitButler commit `xzm` on `scott/canvas-review`; workspace head 9b8e63b7)
- **Severity**: HIGH
- **Category**: 3 Physicality & origin (also 7 Cohesion: crossfade masking)
- **Estimated scope**: 1 file (`plugins/canvas/src/app/comment-margin.tsx`), ~40 lines changed inside one function

## Problem

Clicking a comment avatar grows the real card from the avatar's 28x28 bounds to the
card's full bounds (about 300x187) with one WAAPI transform. The scale is
non-uniform: on the narrow layout the start scale is `scale(0.093, 0.150)`, so for
the first frames the card is a squashed rectangle with squashed text, and the
avatar (a circle) is replaced on frame 0 by a squashed rounded rectangle with a
0.75px x 1.2px corner radius. Collapse plays the same thing in reverse: the last
frames show a 28x28 square-ish box sitting on top of the round avatar, then the box
is removed and the circle pops out.

Recorded evidence: `.scratch/verify-bb-plugins/runs/expand-comments-20260910/evidence/collapse-contact.png`
(bottom row, tiles 1-3 show the squashed box over the avatar) and
`motion-measurements.json` (start transform `scale(0.0933, 0.1496)`).

Current code:

```ts
// plugins/canvas/src/app/comment-margin.tsx:33-84 — current
function animateToggle(rail: HTMLElement, items: MarginItem[], previous: PointerOrigin) {
  const item = items.find((candidate) => candidate.id === previous.id);
  if (!item || item.minimized === previous.minimized) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const element = Array.from(rail.children).find(
    (child) => (child as HTMLElement).dataset.marginId === previous.id,
  );
  const surface = element?.querySelector<HTMLElement>(".canvas-comment-motion");
  if (!surface) return;
  const next = surface.getBoundingClientRect();
  const x = previous.rect.left - next.left;
  const y = previous.rect.top - next.top;
  const target = item.minimized ? previous.snapshot : surface;
  const width = item.minimized ? previous.width : next.width;
  const height = item.minimized ? previous.height : next.height;
  if (!width || !height) return;
  target.style.transformOrigin = "0 0";
  if (item.minimized) {
    // Keep the outgoing card visible while it contracts into the restored avatar.
    // It is a visual snapshot only, never another interactive conversation.
    target.inert = true;
    target.setAttribute("aria-hidden", "true");
    Object.assign(target.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: `${width}px`,
      height: `${height}px`,
      pointerEvents: "none",
    });
    element?.append(target);
  }
  const transform = (left: number, top: number, w: number, h: number) =>
    `translate(${left}px, ${top}px) scale(${w / width}, ${h / height})`;
  // Animate the visual bounds, leaving anchor measurement and scrolling untouched.
  const animation = target.animate(
    [
      { transform: transform(x, y, previous.rect.width, previous.rect.height) },
      { transform: transform(0, 0, next.width, next.height) },
    ],
    {
      duration: 200,
      fill: item.minimized ? "forwards" : "none",
      easing: getComputedStyle(rail).getPropertyValue("--canvas-comment-motion-ease").trim(),
    },
  );
  if (item.minimized) {
    const remove = () => target.remove();
    void animation.finished.then(remove, remove);
  }
  return animation;
}
```

Why it matters: this is the one motion in the comment UI, and it is what the user
sees every time they open or close a conversation. The shape pop at both ends and
the squashed text in the first ~50 ms read as a cheap scale rather than the card
"growing out of" the avatar.

## Target

Keep the existing bounds animation exactly as it is (same 200 ms, same
`--canvas-comment-motion-ease` token, same translate/scale keyframes, same snapshot
mechanism). Add two companion WAAPI animations on the same target, same duration:

1. **Shape**: the card element inside the animated surface animates
   `border-radius` so the avatar-sized end is a circle and the card-sized end is
   the card's normal `8px`. A full ellipse on the unscaled card
   (`border-radius: <width/2>px / <height/2>px`) scales to a circle at the avatar
   end. Expand: circle at 0%, `8px` by 30%, hold. Collapse: `8px` until 60%, circle
   at 100%.
2. **Content**: everything inside the card (messages, resolve button, reply
   composer) and the floating close button animate `opacity`. Expand: `0` until 25%,
   then fade to `1` with the strong ease-out. Collapse: fade `1` to `0` over the
   first 40% with the strong ease-out. The card surface itself (background, border,
   shadow) never fades; only its contents do.

Companion animations are cancelled together with the main animation so a mid-flight
retarget never leaves a stray fade running.

Reduced motion stays exactly as today (early return, instant swap). Keyboard
actions stay instant (unchanged, they never reach this function).

Values (copy exactly):

| Thing                              | Value                                                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duration                           | `200` ms (unchanged)                                                                                                                                              |
| Easing token                       | `--canvas-comment-motion-ease` = `cubic-bezier(0.23, 1, 0.32, 1)` (already in `app.css:904`)                                                                      |
| Expand content opacity keyframes   | `[{ opacity: 0 }, { opacity: 0, offset: 0.25, easing: <token> }, { opacity: 1 }]`, animation `easing: "linear"`                                                   |
| Collapse content opacity keyframes | `[{ opacity: 1, easing: <token> }, { opacity: 0, offset: 0.4 }, { opacity: 0 }]`, animation `easing: "linear"`                                                    |
| Expand radius keyframes            | `[{ borderRadius: circle, easing: <token> }, { borderRadius: "8px", offset: 0.3 }, { borderRadius: "8px" }]`, animation `easing: "linear"`                        |
| Collapse radius keyframes          | `[{ borderRadius: "8px" }, { borderRadius: "8px", offset: 0.6 }, { borderRadius: circle }]`, animation `easing: "linear"`                                         |
| `circle`                           | `` `${cardWidth / 2}px / ${cardHeight / 2}px` `` where `cardWidth`/`cardHeight` are the unscaled `offsetWidth`/`offsetHeight` of the card element inside `target` |

## Repo conventions to follow

- The easing lives as a CSS custom property on the rail: `plugins/canvas/src/app/app.css:903-906`
  ```css
  .canvas-comment-margin {
    --canvas-comment-motion-ease: cubic-bezier(0.23, 1, 0.32, 1);
    position: relative;
  }
  ```
  Read it with `getComputedStyle(rail).getPropertyValue("--canvas-comment-motion-ease").trim()`
  exactly as the existing code does. Do not hard-code the curve in TypeScript.
- WAAPI (`element.animate`) is the existing motion tool in this file. Do not add CSS
  keyframes or a motion library.
- The card element is `article.canvas-comment-card` for threads and
  `div.canvas-comment-composer` for the draft (`plugins/canvas/src/app/comments.tsx:490-497` and `:362`).
  The floating close button is `button.canvas-comment-float-close`, a direct child
  of `.canvas-comment-motion` (`comment-margin.tsx:236-244`).
- Comments in this file are short prose sentences explaining intent. Match that.

## Steps

1. In `plugins/canvas/src/app/comment-margin.tsx`, above `function animateToggle`,
   add the selector for content that fades:

   ```ts
   /** Everything inside the moving surface except the card's own background, border and shadow. */
   const CONTENT_SELECTOR =
     ":scope > .canvas-comment-float-close, .canvas-comment-card > *, .canvas-comment-composer > *";
   ```

2. In `animateToggle`, replace the block from `const transform = (left: number, ...`
   through `return animation;` with:

   ```ts
   const transform = (left: number, top: number, w: number, h: number) =>
     `translate(${left}px, ${top}px) scale(${w / width}, ${h / height})`;
   const easing = getComputedStyle(rail).getPropertyValue("--canvas-comment-motion-ease").trim();
   const duration = 200;
   // Animate the visual bounds, leaving anchor measurement and scrolling untouched.
   const animation = target.animate(
     [
       { transform: transform(x, y, previous.rect.width, previous.rect.height) },
       { transform: transform(0, 0, next.width, next.height) },
     ],
     { duration, fill: item.minimized ? "forwards" : "none", easing },
   );
   // The avatar is a circle and the card is a rounded rectangle. A full ellipse on the
   // unscaled card scales down to the avatar's circle, so the corners morph instead of popping.
   const card = target.querySelector<HTMLElement>(".canvas-comment-card, .canvas-comment-composer");
   const companions: Animation[] = [];
   if (card) {
     const circle = `${card.offsetWidth / 2}px / ${card.offsetHeight / 2}px`;
     companions.push(
       card.animate(
         item.minimized
           ? [
               { borderRadius: "8px" },
               { borderRadius: "8px", offset: 0.6 },
               { borderRadius: circle },
             ]
           : [
               { borderRadius: circle, easing },
               { borderRadius: "8px", offset: 0.3 },
               { borderRadius: "8px" },
             ],
         { duration, fill: item.minimized ? "forwards" : "none", easing: "linear" },
       ),
     );
   }
   // Text squashed into a 28px box is noise. Hide the contents while the surface is
   // too small to read and let them fade in once the card is most of its final size.
   for (const content of target.querySelectorAll<HTMLElement>(CONTENT_SELECTOR)) {
     companions.push(
       content.animate(
         item.minimized
           ? [{ opacity: 1, easing }, { opacity: 0, offset: 0.4 }, { opacity: 0 }]
           : [{ opacity: 0 }, { opacity: 0, offset: 0.25, easing }, { opacity: 1 }],
         { duration, fill: item.minimized ? "forwards" : "none", easing: "linear" },
       ),
     );
   }
   const settle = () => {
     for (const companion of companions) companion.cancel();
     if (item.minimized) target.remove();
   };
   void animation.finished.then(settle, settle);
   return animation;
   ```

   Resulting function shape: everything above `const transform` is unchanged; the
   old `if (item.minimized) { const remove = ... }` block is gone because `settle`
   now removes the snapshot.

3. Nothing else changes. `motion.current` still holds only the main bounds
   animation, and the existing `playState === "running"` retarget logic in
   `onClickCapture` (`comment-margin.tsx:206-212`) keeps working because the
   companions are cancelled whenever the main animation is cancelled.

## Boundaries

- Do NOT touch `review.tsx`, `comments.tsx`, `app.css`, or the Docs plugin.
- Do NOT change the bounds keyframes, duration, easing token, the snapshot
  placement, or the reduced-motion early return.
- Do NOT change markup. The selector in step 1 targets existing class names only.
- Do NOT add dependencies.
- If `animateToggle` no longer matches the excerpt above (drift since commit
  15b60592), STOP and report instead of improvising.

## Verification

- **Mechanical**:
  ```sh
  cd plugins/canvas && bun run typecheck && bunx oxlint src/app/comment-margin.tsx && bun test
  ```
  Expected: typecheck clean, no lint findings, tests pass. (No test covers
  `CommentMargin`; do not add one that asserts on WAAPI internals.)
- **Feel check** (Docs plugin renders this UI; open a `.canvas.mdx` with at least one
  comment in a pane narrower than 760px so the card overlays the text):
  - Click the avatar. In DevTools > Animations, set playback to 10% and replay: the
    first frames show a plain circle the same size and place as the avatar, its
    corners relax into the 8px card radius within the first third, and the messages
    fade in only once the card is roughly 80% of its final size. Text is never
    visibly squashed.
  - Click the × (or, after plan 002, anywhere in the document). At 10% playback the
    messages fade out immediately, the surface shrinks, and the last frames are a
    circle that lands exactly on the avatar with no square-to-circle pop.
  - Click × mid-expand and the avatar mid-collapse: the surface retargets from
    where it visually is (unchanged behavior). Known minor seam: reopening
    mid-collapse restarts the content fade from 0 instead of from the snapshot's
    current opacity. Acceptable; note it if it looks worse than today.
  - Toggle `prefers-reduced-motion: reduce` in DevTools > Rendering: open/close is an
    instant swap, as today.
  - Wide pane (>760px): the card grows from the avatar over the text into the
    sidebar column; shape and content behave as above.
- **Done when**: all three feel checks pass in the narrow layout and the wide layout,
  typecheck and lint are clean.

## Note for the reviewer

The user asked for the actual card to grow from the avatar with no hover fading.
This plan keeps the card surface fully opaque throughout and only crossfades the
card's _contents_ while the surface is unreadably small. If even that is
unwanted, the alternative that preserves "no opacity change anywhere" is a
counter-scaled content layer (inner element animated with the inverse scale via
sampled keyframes) plus `overflow: hidden` on the surface. It costs a bezier
solver and clips the card's box-shadow during the animation. Ask before choosing
it.
