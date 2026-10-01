# Visual design

## Composition

- Prefer one dominant visual and compact controls. Add metrics only when they
  explain the behavior. Put changing values beside their controls or marks.
- Avoid filler cards, invented scores, redundant legends, and controls that do
  not serve the requested comparison. Put a short explanation beside the embed
  instead of repeating the answer inside it.
- Keep presentation interactions local. Make the first render useful before
  input changes, and use one control mechanism for each state.
- For comparisons, use shared scales and show the requested dimensions together.
  For sequences or parallel work, align lanes on one time axis and annotate
  waits and bottlenecks there. For allocation, show the category breakdown.
- For UI previews, use the product's own typography, colors, and chrome. Show
  realistic states. Offer a few local design alternatives when they help the
  user choose, without turning the preview into a settings dashboard.

## Responsive visuals and accessibility

- Fit the chat width and reflow down to 320px. Stack or wrap content rather than
  shrinking text. Keep chart labels at least 11 screen pixels and reserve space
  for the longest formatted values.
- Size SVGs from their actual containers. Redraw charts on resize rather than
  shrinking a fixed desktop viewBox. Reduce ticks and optional annotations
  before sacrificing readable labels.
- Use semantic, labeled native controls with keyboard access and visible focus.
  Keep essential content available without hover. Provide touch targets around
  44px and a tap alternative for hover details.
- Announce meaningful dynamic results with `aria-live="polite"`, not every
  animation frame. Give charts a concise accessible description. Pair color
  with labels, shapes, or line styles.
- Define the visual's own theme-aware styles and verify contrast on its actual
  background. Keep category colors consistent across marks and legends.
  Keep explanatory surfaces quiet and avoid decorative container chrome.
- Animate state changes only when motion clarifies the relationship. Respect
  `prefers-reduced-motion`; avoid gratuitous entrance animations or loops.
  Recorded demos can retain the playback behavior in [video delivery](video.md).

## Charts and data

- Prefer simple SVG for a few directly labeled values. Use a plotting library
  when scales, dense data, or native interactions materially improve the result.
- Derive domains from the data, including uncertainty and reference values.
  Label quantities and units, keep marks within the plot, and prevent overlap
  among ticks, labels, legends, and annotations.
- For multi-series inspection, show values at a consistent x position so the
  tooltip supports comparison. Toggle each series and its tooltip row together.
- Use uncertainty bands for dense estimates and whiskers for isolated ones.
  Aggregate or downsample large datasets without hiding relevant variation.
- Use sourced geographic geometry and coordinates for maps. Do not invent
  outlines or present a blank coordinate field as a geographic basemap.
