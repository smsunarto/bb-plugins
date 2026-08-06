# Design System

## Direction: Narrative Review Reader

Use a dense, full-height code-review workstation composed from shadcn `radix-lyra`. The center is a continuous review document. Side rails support navigation and evidence. A two-tab Normal/Guide control changes only how the active group's same diff evidence is read.

## Visual World

- Near-black matte neutral surfaces.
- One blue focus accent.
- Yellow for modified-file state. Green and red only for Git additions and deletions.
- One-pixel borders, limited elevation, and 6–8px radii.
- No gradients, glass effects, decorative canvases, oversized cards, or vendor branding.

## Typography

- System sans for interface text; self-hosted Berkeley Mono for code, paths, refs, and counts.
- Base text: 13–14px with compact line height.
- Group heading: 23–25px.
- Section heading: 14–16px.
- Code and metadata: 12–13px.
- Use weight and spacing instead of display-size typography.

## Desktop Layout

- Fixed 48px PR header and no bottom footer.
- Three independently scrolling shadcn `ResizablePanel` regions only when supporting evidence exists.
- Left: about 21%; semantic review groups and reviewed state.
- Center: about 54%; group intent, explanation, progress, and continuous Diffs patches.
- The review document fills the center width. Do not cap it with a prose-style maximum.
- Right: about 25%; only available relevant specs and links plus existing notes.
- Render every right-rail item as a plain sibling section with no enclosing evidence card or divider between sections.
- Omit empty sections and omit the entire rail when no supporting evidence exists.
- Let the center remain dominant. A visible right rail uses at least 320px so filenames and stats do not collide.

## Narrow Layout

- Keep the review document visible and dominant.
- Move group navigation to a shadcn `Sheet` below 1280px.
- Move available supporting sections directly above Changed files as flat siblings.
- Omit any supporting section without content.
- Put the icon-only Groups trigger at the far-left edge of the PR header, aligned to the review-document gutter, without an extra padded block.
- Let the sheet close action reach the right edge of its header without an extra inset.
- Hide header search below 1024px so controls and PR identity retain stable space.
- Keep touch targets at least 44px and preserve semantic-group keyboard navigation.

## Review Groups

- Show sequence, title, file count, additions/deletions, concise summary, and reviewed state.
- Compose dense group and file-preview rows with shadcn `Item` and `ItemGroup`.
- Expand the active group with a compact file preview.
- Use blue border and selection fill for the active group.
- Do not add an Active chip; the selected card treatment already communicates that state.
- Use green reviewed state with an icon, not color alone.
- Do not create a fileless group to fill the interface.

## Review Document

Open PR, Mark reviewed, Reviewed badges, and segmented-control outer corners use `rounded-md`; segmented inner seams remain square.

- Lead with section position, title, one concrete summary sentence, and mode-specific progress.
- Put a prominent shadcn Normal/Guide tab control directly below progress. Do not wrap either mode's content in a new card or bordered container.
- Normal retains the existing Changed files Tree and file-oriented continuous diff flow without structural changes.
- Guide replaces the Tree with a compact, informational phase outline and renders only authored phases. It does not preserve scroll offsets or add phase jump links.
- Guide phases are flat semantic sections. Foundations, APIs, behavior, integration, and tests open by default; miscellaneous and generated output start collapsed in a flat shadcn Accordion.
- Each Guide excerpt has its own Pierre header, collapse state, Viewed toggle, rationale, and optional read-only line annotations. Repeated excerpts from one file remain separate review items.
- Render an inline read-only React Flow diagram only when authored for that phase. Give it a text summary, explicit height, stable node positions, and no editing controls or reserved empty space.
- Put the active group’s single Changed files Tree immediately below the Changed files heading and controls, before its inline diffs.
- Hide generated paths from that Tree by default and use one shadcn `Toggle` with visible `Show generated` / `Hide generated` state copy to include them. Fade generated rows when shown. Tests remain ordinary changed paths and do not get a duplicate section.
- Put short file explanation in Pierre’s header suffix as quiet context, never as an alert.
- Keep unified/split controls available.
- Render actual Diffs patches in authored order.
- Preserve Pierre’s header layout, file icon, filename, rename handling, line totals, code styling, and landing-page hunk separator treatment.
- Use Pierre’s exact 24px zero-padding collapse prefix with `margin-left: -5px`; adapt only its colors.
- Give Viewed visually equal padding on every side and retain Pierre’s compact selected-state treatment.
- Add no external-link or information-icon action to the file header.
- Give each file one visible border and independent `options.collapsed` state. Keep file headers sticky and make the complete native header toggle that state.
- Make code and background fill the bordered diff surface to its right and bottom edges. Horizontal scrolling belongs only inside that clipped surface.
- Use Pierre’s native expandable line-info treatment only when exact old and new file content was deliberately included through the explicit localhost-only full-context mode. Patch-only builds must not display a dead expansion affordance.
- Give every file a Viewed toggle. Marking it collapses an open diff; clearing it preserves the current collapsed state. The group action updates every file in the active group.
- Keep Mark reviewed neutral until selected; the selected state uses green text, border, tint, and a check icon with the label Reviewed.
- Keep generated files in Normal progress and evidence, but render them under their own heading after primary diffs and inside one collapsed shadcn `Accordion` without an enclosing card. Guide-generated and binary whole-file items remain optionally viewable but do not enter its numerator or denominator.
- Do not render Go to bottom. Show Go to top at bottom right only after the review document leaves its top edge.

## Supporting Evidence Rail

Use this order and omit missing entries:

1. Relevant specs and links.
2. Existing review notes.

Each entry stands alone as a flat semantic section. Do not add an enclosing evidence container, a divider between sections, or a “View all” action.

The center Changed files Tree uses full paths, Git state, flattened empty directories, 24px rows, walkthrough order, density `0.8`, and 8px inline padding. Sticky folders are disabled. It sizes exactly to visible rows plus its 1px top and bottom borders, adds no block padding, never becomes internally scrollable, and has no forced minimum-height gutter. Tree selection scrolls to the matching inline diff.

## Shared Review Surface

Diff files, the Changed files Tree, and grouped supporting rows share clipped overflow, `rounded-md`, one thin border, and `bg-background`. Section headings, rails, generated Accordion headings, and splitters remain flat and unframed. This keeps radius and containment consistent without creating nested card stacks.

## Interaction

- Group selection updates explanation, supporting evidence, and diffs together.
- File viewed state persists when its file surface is collapsed. Clicking anywhere in the native file header toggles collapse, except the Viewed control, which stops header propagation.
- Normal progress counts files. Guide progress counts only non-generated, non-binary excerpts. The two item-level progress sets never synchronize.
- The group `Mark reviewed` action updates every Normal file and every Guide excerpt. Clearing it clears both modes. Completing either mode is sufficient for the group Reviewed state.
- Persist the selected mode and both progress sets locally under the PR and head commit identity. Do not persist or restore mode-specific scroll positions.
- Arrow keys or `n`/`p` move between semantic groups.
- Changed files Tree clicks scroll to the exact inline patch.
- Each inline diff owns horizontal scrolling inside a clipped width-bound container.
- Transitions take 150–220ms and respect reduced motion.
- Focus rings remain visible. Current and reviewed state must not depend on color alone.
- Use shadcn `Toggle` for persistent state, `Item` for dense rows, and `Empty` only for true no-data states. Keep plain semantic sections plain.

## Avoid

Secondary patch browsers, standalone conceptual visualization dashboards, alphabetical-first review paths, nested card stacks, dividers between evidence sections, large empty gutters, internally scrolling file Trees, custom look-alike components, fake findings, fake chat, approval controls, marketing copy, and copied competitor chrome outside the named Pierre primitives.
