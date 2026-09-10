# 003 — Give the draft composer a 160 ms entrance instead of appearing from nowhere

- **Status**: DONE (applied 2026-09-10, verified in isolated bb run motion-20260910-1530)
- **Commit**: 15b60592 (GitButler commit `xzm` on `scott/canvas-review`; workspace head 9b8e63b7)
- **Severity**: LOW
- **Category**: 8 Missed opportunities (spatially connected UI with no motion explaining where it came from)
- **Estimated scope**: 1 file (`plugins/canvas/src/app/app.css`), ~20 lines added. CSS only.

## Problem

Clicking "Comment" in the selection popover (or pressing ⌘⇧M) mounts the draft
composer as the `draft` margin item (`review.tsx:370-393`). `layout()` positions it
above the passage in the overlay layout, or in the sidebar column beside the
passage in the wide layout, and it simply appears. It is the only comment surface
with no entrance: threads grow from an avatar, but a new comment has no avatar to
grow from. The composer is spatially tied to the passage the user just selected,
and a brief entrance should say so.

The draft never toggles, so `animateToggle` in `comment-margin.tsx` does not apply
to it (`items.find` matches it but `minimized` is always `false`).

Current CSS for the moving surface (there is no entrance rule today):

```css
/* plugins/canvas/src/app/app.css:903-909 — current */
.canvas-comment-margin {
  --canvas-comment-motion-ease: cubic-bezier(0.23, 1, 0.32, 1);
  position: relative;
}
.canvas-comment-motion {
  display: grid;
}
```

## Target

On mount, the draft's surface (`.canvas-comment-motion` inside the item whose
`data-margin-id` is `draft`) transitions from `opacity: 0; transform: scale(0.97)`
to `opacity: 1; transform: none` in 160 ms with
`var(--canvas-comment-motion-ease)`, using `@starting-style`. The transform origin
points at the passage: bottom-left (`0 100%`) in the overlay layout where the
composer sits above the passage, top-left (`0 0`) in the wide layout where it sits
beside the passage's first line.

Under `prefers-reduced-motion: reduce` the scale is dropped and only the 160 ms
opacity fade remains (reduced motion keeps comprehension aids, removes movement).

The keyboard shortcut path (⌘⇧M) also mounts the draft. That is a mount, not a
toggle of an existing element, and 160 ms of opacity/scale on a surface that the
keyboard user is about to type into is acceptable. If the reviewer disagrees,
the fallback is to gate the rule behind a `data-pointer` attribute set by
`review.tsx`; that is out of scope for this plan and would need a follow-up.

Values (copy exactly):

| Thing                                                       | Value                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Duration                                                    | `160ms`                                                                                   |
| Easing                                                      | `var(--canvas-comment-motion-ease)` (= `cubic-bezier(0.23, 1, 0.32, 1)`)                  |
| Starting style                                              | `opacity: 0; transform: scale(0.97);`                                                     |
| Transform origin, wide                                      | `0 0`                                                                                     |
| Transform origin, overlay (`@container (max-width: 760px)`) | `0 100%`                                                                                  |
| Reduced motion                                              | `transition: opacity 160ms var(--canvas-comment-motion-ease)`, starting `transform: none` |

## Repo conventions to follow

- The easing token is `--canvas-comment-motion-ease`, declared on
  `.canvas-comment-margin` (`app.css:904`). Reuse it; do not add a second curve.
- Overlay-layout overrides live inside `@container (max-width: 760px)` blocks
  (`app.css:1000-1040`); add the overlay transform-origin inside that existing block.
- Reduced-motion overrides live in `@media (prefers-reduced-motion: reduce)`
  (`app.css:654-658`). Add a second block near the new rule rather than editing that one.
- The WAAPI toggle animation in `comment-margin.tsx` sets `transform` on
  `.canvas-comment-motion` of _thread_ items. The selector here is scoped to the
  draft item only, so a CSS `transition: transform` never competes with WAAPI.

## Steps

1. In `plugins/canvas/src/app/app.css`, directly after the `.canvas-comment-motion { display: grid; }`
   rule (line 907-909), add:

   ```css
   /* A new comment has no avatar to grow from, so it eases in from the passage it belongs to. */
   .canvas-comment-margin-item[data-margin-id="draft"] > .canvas-comment-motion {
     transform-origin: 0 0;
     transition:
       opacity 160ms var(--canvas-comment-motion-ease),
       transform 160ms var(--canvas-comment-motion-ease);
   }
   @starting-style {
     .canvas-comment-margin-item[data-margin-id="draft"] > .canvas-comment-motion {
       opacity: 0;
       transform: scale(0.97);
     }
   }
   @media (prefers-reduced-motion: reduce) {
     .canvas-comment-margin-item[data-margin-id="draft"] > .canvas-comment-motion {
       transition: opacity 160ms var(--canvas-comment-motion-ease);
     }
     @starting-style {
       .canvas-comment-margin-item[data-margin-id="draft"] > .canvas-comment-motion {
         transform: none;
       }
     }
   }
   ```

2. Inside the existing `@container (max-width: 760px) { ... }` block that starts at
   `app.css:1000` (the one containing `.canvas-comment-margin { --canvas-comment-overlay: 1; }`),
   add:

   ```css
   .canvas-comment-margin-item[data-margin-id="draft"] > .canvas-comment-motion {
     transform-origin: 0 100%;
   }
   ```

3. Run `bunx oxfmt plugins/canvas/src/app/app.css` only if the repo's formatter
   touches CSS in your environment; otherwise leave formatting as written.

## Boundaries

- Do NOT touch `comment-margin.tsx`, `review.tsx`, `comments.tsx`, or the Docs plugin.
- Do NOT apply the transition to thread items (selector must keep `[data-margin-id="draft"]`).
- Do NOT add JS, a `data-mounted` fallback, or a dependency. bb runs on Chromium
  (bb 0.42.1) which supports `@starting-style`; the remote web client is also
  Chromium-based.
- If the CSS at the cited lines does not match (drift since commit 15b60592), STOP
  and report.

## Verification

- **Mechanical**:
  ```sh
  cd plugins/canvas && bunx oxlint && bun run typecheck && bun run build
  grep -c "starting-style" dist/app.css   # expected: 2 or more
  ```
  The Docs plugin bundles this file via the `./editor.css` export
  (`plugins/canvas/package.json:114`); build Docs too (`cd ../docs && bun run build`)
  and grep its `dist/app.css` the same way to confirm the at-rule survived bundling.
- **Feel check** (Docs, any `.canvas.mdx`):
  - Narrow pane (<760px): select text, click "Comment". At DevTools > Animations 10%
    playback the composer fades and scales up from its bottom-left corner, i.e.
    from the passage below it, settling in 160 ms. No jump after it settles.
  - Wide pane (>760px): same, scaling from its top-left toward the passage.
  - ⌘⇧M with a selection: same entrance; the textarea has focus and typing during
    the 160 ms is not delayed.
  - Reduced motion: fade only, no scale.
  - Cancel the draft and start another: entrance plays again (it is a fresh mount).
- **Done when**: the at-rule is present in both built CSS files and the four feel
  checks pass.
