# PR Walkthrough Repository Guide

## Purpose

This repository owns the `bb-plugin-pr-walkthrough` bb plugin, the reusable `pr-walkthrough` skill it ships, and the neutral static review product. The product helps a human understand a pull request in a deliberate semantic order. It is an orientation and reading-progress tool, not an automated code-review verdict.

Keep the diff as the primary surface. Do not add findings, severities, approval recommendations, merge controls, fake discussion, or vendor-specific branding.

## Source of Truth

- `package.json` is the bb plugin manifest (`bb.server`, `bb.app`, `bb.skills`).
- `server.ts` is the plugin backend: one RPC that reads a thread workspace's compiled `walkthrough.generated.json` (confined via `bb.sdk.files.read` with `rootPath`) and returns it typed.
- `app.tsx` is the plugin frontend: the `::pr-walkthrough{...}` message directive and the viewer thread-panel tab that renders review groups, explanations, and diffs natively with the host-shimmed `@pierre/diffs` renderer and the host `Markdown` component.
- `skills/pr-walkthrough/SKILL.md` defines agent behavior and the public product contract. bb injects it into agent threads as the plugin skills tier.
- `skills/pr-walkthrough/agents/openai.yaml` contains Codex skill-list metadata and must remain consistent with `SKILL.md`.
- `skills/pr-walkthrough/workflow.js` is the bundled bb workflow that orchestrates generation across worker agents (Context → Plan → Author → Assemble → Repair → Validate). Its worker prompts delegate the authoring contract to `SKILL.md`, so contract changes there must stay compatible with the workflow's phase boundaries, `args` (`skillDir`, `request`), and structured result schemas. The skill launches it with inline source because the installed skill directory lives outside thread workspaces. Validate edits with `bb workflows validate --script` against a running bb.
- `skills/pr-walkthrough/assets/site-template/` is the authoritative reusable application.
- `skills/pr-walkthrough/assets/site-template/PRODUCT.md` and `DESIGN.md` define product and visual decisions.
- `skills/pr-walkthrough/scripts/` contains reusable migration, scaffolding, and validation commands. `scaffold_site.py` locates the template relative to itself, so scripts and assets must stay siblings inside the skill directory.
- `examples/rampage-client-pr-1634/` is a preserved example and design-evidence fixture. It is not the reusable product source.
- `components/ui/`, `lib/`, `hooks/`, and `types/` are vendored bb plugin scaffold support (shadcn model plus bundled SDK type declarations). Edit vendored components freely; refresh SDK types only from a matching bb release.

Never develop against an installed copy (`bb plugin list` path or `~/.codex/skills/pr-walkthrough`) and then copy changes back. Make changes here first. Update an installed copy only when the user explicitly asks to install or synchronize, and only after repository validation passes.

## Product Invariants

### One review path, two readings

- Semantic review groups define one ordered implementation story.
- Normal mode reviews complete changed files in authored group order.
- Guide mode reviews model-authored logical excerpts ordered by implementation dependency.
- Normal file progress and Guide excerpt progress are independent and never synchronize item by item.
- Completing either Normal or Guide marks the group Reviewed.
- The group-level action marks or clears every Normal file and every Guide excerpt. Its copy must make that cross-mode scope explicit.
- Reviewed means local reading progress only. It never implies correctness, safety, approval, or completed code review.

### Canonical authoring

- Use one `index.mdx` for PR metadata and ordered section references.
- Use one MDX file per semantic review group.
- Put exactly one `## Guide` block in the same section file as its Normal metadata and explanation.
- Assign every changed file to exactly one group.
- Require every textual added and deleted line to appear exactly once across Guide excerpts. Context may repeat; selected changed lines may not overlap or be omitted.
- Allow one native Git hunk to be split across several logical excerpts.
- Use the fixed Guide phase vocabulary in this order, omitting empty phases:
  1. Foundations and data structures
  2. APIs and entrypoints
  3. Core behavior
  4. Integration and wiring
  5. Tests and verification
  6. Imports, formatting, and miscellaneous
  7. Generated output
- Make phase and excerpt prose substantive. Explain rationale, invariants, authority boundaries, tradeoffs, and reading order; do not paraphrase obvious code.

### Generated and binary evidence

- Keep generated, binary, lockfile, snapshot, and metadata changes viewable.
- Count them in Normal file progress.
- Put primary Normal diffs first and generated files in one collapsed section afterward.
- Put generated and binary Guide items in the final collapsed Generated output phase as whole-file items.
- Exclude generated and binary Guide items from the Guide completion numerator and denominator.
- Hide generated paths from the Changed files tree by default; one Show/Hide generated toggle includes faded rows in the same tree.

## Interface Contract

- Use the existing Next.js/Nextra static-export stack, pnpm, TypeScript, Tailwind CSS 4, and Oxlint.
- Use actual shadcn `radix-lyra` components. Prefer `Toggle` for persistent state, `Item` for dense rows, and `Empty` only for genuine no-data states.
- Use Pierre Trees for the active group’s Changed files tree and Pierre Diffs for code.
- Use React Flow only for an authored, read-only Guide diagram when relationships, state flow, or sequencing become materially clearer. Do not reserve diagram space or create a separate visualization mode.
- Preserve Pierre’s native file header, icon, filename, status, totals, and hunk treatment. Add only the supported collapse prefix, local Viewed metadata, authored notes, and read-only annotations.
- Keep the whole Pierre header clickable for collapse. Stop propagation from Viewed. Marking Viewed collapses an open item; clearing Viewed does not expand it.
- Keep Unified/Split as one shared preference across Normal and Guide.
- Use self-hosted Berkeley Mono only for code and monospaced metadata. Do not hotlink fonts or publish the licensed font files without confirming redistribution rights.

### Layout and visual rules

- Keep the center diff document dominant and full width; do not apply a prose-width cap.
- Use a 48px header and no footer.
- At desktop widths, use two or three resizable panels. Render the supporting rail only when relevant specs, links, or existing comments exist.
- Below 1280px, move groups into a shadcn Sheet and supporting evidence above Changed files.
- Hide search below 1024px.
- Maintain at least 44px effective touch targets on narrow screens, including icon-only header actions. The Pierre collapse glyph may remain visually 24px wide if its effective target is larger.
- Use flat semantic sections. Avoid nested cards, enclosing evidence containers, section dividers, empty placeholders, artificial minimum heights, and internal tree scrolling.
- Use blue for focus, links, explanation, and progress; yellow for modified files; green/red only for Git additions and deletions.
- Show Go to top only after the review viewport leaves its top edge. Do not add Go to bottom.
- Do not add phase jump links or a second file browser.

### Persistence, search, and accessibility

- Persist the selected mode plus independent Normal and Guide progress sets in local storage keyed by PR identity and head SHA.
- Do not persist or restore scroll positions.
- Do not silently swallow persistence failure. Provide quiet save status and a persistent, non-blocking recovery path when storage fails.
- Search currently filters semantic groups and referenced file paths. Label that scope honestly unless patch-content search is implemented and verified.
- Preserve semantic landmarks, accessible names, focus visibility, keyboard navigation, reduced-motion behavior, and non-color status cues.

## Current Product Priorities

The latest critique is `examples/rampage-client-pr-1634/critique/2026-08-03T07-58-40Z__pr-walkthrough-site-src-app-page-mdx.md` and scored 28/40. Treat these as the current ordered improvement backlog unless the user chooses a different scope:

1. Preserve section, active Guide phase, and progress context while scrolling long reviews.
2. Rename and explain the group-level bulk action so its Normal-plus-Guide scope is unmistakable, with reversible feedback.
3. Verify and fix 44px narrow-screen hit areas against a freshly built artifact.
4. Rename search to match group/path scope or implement real patch-content search.
5. Surface local-progress save failures with retry or export guidance.

Do not resolve the long-review problem by turning the Guide outline into a jump-link dashboard. Prefer compact sticky context and a restrained next-unreviewed affordance.

## Development Workflow

Work from the repository root. Preserve unrelated user changes and do not commit or push unless asked.

When editing the product:

1. Update `skills/pr-walkthrough/assets/site-template/`.
2. Update `SKILL.md`, `PRODUCT.md`, `DESIGN.md`, compiler contracts, and validator rules when behavior or authoring constraints change.
3. Never hand-edit `src/data/walkthrough.generated.json`; regenerate it.
4. Keep exact dependency versions and the committed pnpm lockfile.
5. Use official local package documentation or maintained upstream documentation before relying on a new or unstable API.

Required checks:

```bash
pnpm --dir skills/pr-walkthrough/assets/site-template install --frozen-lockfile
pnpm --dir skills/pr-walkthrough/assets/site-template run check
python3 skills/pr-walkthrough/scripts/validate_site_template.py --site skills/pr-walkthrough/assets/site-template --built
```

When editing the plugin (`server.ts`, `app.tsx`, manifest, vendored UI):

```bash
npm install
npx tsc --noEmit
bb plugin build
```

Use `bb plugin dev` for a live rebuild/reload loop against a running bb, and `bb plugin logs pr-walkthrough -f` for backend logs.

Validate the skill package with the `skill-creator` `quick_validate.py` command when that tool is available. If its runtime lacks PyYAML, use a temporary validation environment rather than adding PyYAML to this product.

For an example reconstruction:

```bash
python3 skills/pr-walkthrough/scripts/scaffold_site.py \
  --content examples/rampage-client-pr-1634/walkthrough \
  --diff examples/rampage-client-pr-1634/changes.patch \
  --output /tmp/pr-walkthrough-example
```

## Preview and Security

Default to patch-only artifacts and localhost preview:

```bash
python3 -m http.server 4173 \
  --bind 127.0.0.1 \
  --directory skills/pr-walkthrough/assets/site-template/out
```

- Do not expose private PR patches or code to a LAN, public host, or external service without explicit authorization.
- Full-context builds embed exact old/new Git blobs and are localhost-only. Never bind them to `0.0.0.0`.
- Before any network-accessible preview, regenerate without full context so stale private source cannot remain in `.next/` or `out/`.

## Verification Standard

Do not report a UI change ready based only on source checks. After a fresh build, inspect desktop and narrow layouts in a real browser and verify the relevant interactions, horizontal containment, static relative assets, and console output.

If browser validation is unavailable, state that rendering is unverified. Do not infer current behavior from an older `out/` bundle or audit screenshot.
