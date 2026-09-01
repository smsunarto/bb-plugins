# GTD Sidebar mobile density QA

- Source visual truth: `/Users/smsunarto/.bb/thread-storage/thr_e9rexrqp8j/Attachments/IMG_3686-1788306268099-66grth.png`
- Implementation screenshots:
  - Density: `/Users/smsunarto/.bb/thread-storage/thr_e9rexrqp8j/gtd-mobile-qa/after-selected.png`
  - Footer transition: `/Users/smsunarto/.bb/thread-storage/thr_e9rexrqp8j/gtd-mobile-qa/after-footer-fade.png`
  - List scrolled to bottom: `/Users/smsunarto/.bb/thread-storage/thr_e9rexrqp8j/gtd-mobile-qa/after-footer-fade-scrolled.png`
- Combined comparisons:
  - Density: `/Users/smsunarto/.bb/thread-storage/thr_e9rexrqp8j/gtd-mobile-qa/comparison.png`
  - Footer transition: `/Users/smsunarto/.bb/thread-storage/thr_e9rexrqp8j/gtd-mobile-qa/footer-fade-comparison.png`
- Viewports: 390 x 844 CSS pixels for density, then 390 x 600 for the footer edge.
- Source pixels: 1320 x 2868. Normalized from the inferred 3x iPhone capture to 440 x 956 logical pixels.
- Implementation pixels: 390 x 844 at device scale factor 1.
- Comparison crop: source sidebar at 320 x 844 logical pixels beside the 315 x 844 rendered bb sidebar.
- State: dark theme, mobile sidebar open, first thread selected.

## Scope

The reference supplies the target density, single-line thread shape, and selected-row treatment. Its ChatGPT-specific navigation, copy, and branding are not implementation targets. The GTD Sidebar keeps bb's product chrome, tokens, thread indicators, and actions.

## Full-view comparison

The updated list uses a 40-pixel row with a 4-pixel gap. This matches the reference's compact single-line rhythm and rounded selected row. Nine GTD threads now fit in the area that held six two-line cards before the change. The mobile sheet width remains host-owned and already matches the reference closely.

## Focused comparison

The footer comparison crops the reference to its lower 600 logical pixels and places it beside the rendered 390 x 600 sidebar. The implementation now fades the final 32 pixels of scrolling content into the mobile footer surface. The footer icons stay sharp and outside the masked region.

## Required fidelity surfaces

- Fonts and typography: bb keeps its system font and 14-pixel sidebar title scale. Titles stay single-line with truncation. The reference uses a larger product-specific scale, but matching it would break bb's existing navigation hierarchy.
- Spacing and layout rhythm: 40-pixel thread rows and 4-pixel gaps match the reference's compact rhythm. The selected fill stays within the same row height.
- Colors and visual tokens: existing bb sidebar tokens preserve dark-theme contrast. The selected gray fill and muted secondary indicators follow the reference's balance.
- Image quality and asset fidelity: the target contains no app-owned raster imagery. Existing bb and provider icons remain sourced from the current icon components.
- Copy and content: GTD thread titles and section names remain unchanged. Reference copy differs because it belongs to another product.

## Interaction and runtime checks

- Opened the sidebar at 390 x 844.
- Opened `Unrelated root task`, confirmed the mobile sheet closed, then reopened it.
- Confirmed the selected row rendered at the compact height.
- Confirmed status, provider glyphs, activity indicators, and action menus remain visible.
- Reduced the viewport to 390 x 600 and confirmed the list no longer ends at a hard edge above the footer.
- Set the list to its maximum scroll offset, 182 of 182 pixels, and confirmed the final row clears the fade.
- Browser page errors: none.
- Console: one pre-existing Jotai `loadable` deprecation warning.

## Comparison history

### Initial pass

- P2: active mobile cards used two lines and exposed project and branch metadata. Only six threads fit above the same fold.
- Fix: collapsed mobile cards to one line and moved status, provider, activity, and pull-request indicators onto that row. Desktop cards remain unchanged.
- Post-fix evidence: `after-selected.png` and `comparison.png` show the compact selected row and nine visible threads.

### Footer transition follow-up

- P2: scrolling content stopped at the footer boundary with a hard visual cut.
- Fix: applied a 32-pixel mobile-only content mask and matching bottom scroll padding. Desktop rendering remains unchanged.
- Post-fix evidence: `after-footer-fade.png` and `footer-fade-comparison.png` show the soft edge. `after-footer-fade-scrolled.png` shows the final row fully visible at maximum scroll.

## Findings

No actionable P0, P1, or P2 differences remain within the requested mobile-density scope.

final result: passed
