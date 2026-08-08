#!/usr/bin/env python3
"""Validate the reusable PR walkthrough source and static export."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

REQUIRED_FILES = (
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "next.config.mjs",
    "components.json",
    ".oxlintrc.json",
    "scripts/compile_walkthrough.py",
    "scripts/guide_contract.py",
    "src/app/page.mdx",
    "src/app/fonts/BerkeleyMono-Regular.woff2",
    "src/app/fonts/BerkeleyMono-Oblique.woff2",
    "src/app/fonts/BerkeleyMono-Medium.woff2",
    "src/app/fonts/BerkeleyMono-SemiBold.woff2",
    "src/app/fonts/BerkeleyMono-Bold.woff2",
    "src/content/walkthrough/index.mdx",
    "src/components/walkthrough/walkthrough-app.tsx",
    "src/components/walkthrough/diff-options.ts",
    "src/components/walkthrough/guide-content.tsx",
    "src/components/walkthrough/guide-diagram.tsx",
    "src/components/walkthrough/guide-document.tsx",
    "src/components/walkthrough/guide-line-comment.tsx",
    "src/components/walkthrough/review-context-sidebar.tsx",
    "src/components/walkthrough/review-document.tsx",
    "src/components/walkthrough/review-group-rail.tsx",
    "src/components/walkthrough/review-surface.ts",
    "src/components/walkthrough/source-diff.tsx",
    "src/components/walkthrough/source.tsx",
    "src/components/ui/empty.tsx",
    "src/components/ui/accordion.tsx",
    "src/components/ui/button-group.tsx",
    "src/components/ui/item.tsx",
    "src/components/ui/toggle.tsx",
    "src/components/ui/toggle-group.tsx",
    "src/data/walkthrough.generated.json",
    "src/data/walkthrough.patch",
)
REQUIRED_DEPENDENCIES = (
    "@pierre/diffs",
    "@pierre/trees",
    "@xyflow/react",
    "next",
    "nextra",
    "nextra-theme-docs",
    "radix-ui",
)
FORBIDDEN_FILES = (
    "design-qa.md",
    "src/components/ui/card.tsx",
    "src/components/walkthrough/graph-canvas.tsx",
    "src/components/walkthrough/diff-browser.tsx",
)
FORBIDDEN_DEPENDENCIES: tuple[str, ...] = ()
FULL_CONTEXT_MARKER = Path("src/data/full-context.enabled")
GUIDE_PHASES = (
    "foundations",
    "apis",
    "behavior",
    "integration",
    "tests",
    "misc",
    "generated",
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", required=True, type=Path)
    parser.add_argument("--built", action="store_true", help="Also require out/index.html.")
    args = parser.parse_args()

    site = args.site.resolve()
    errors: list[str] = []
    for relative_path in REQUIRED_FILES:
        if not (site / relative_path).is_file():
            errors.append(f"missing {relative_path}")
    for relative_path in FORBIDDEN_FILES:
        if (site / relative_path).exists():
            errors.append(f"removed walkthrough component is still present: {relative_path}")

    package_path = site / "package.json"
    if package_path.is_file():
        package = json.loads(package_path.read_text(encoding="utf-8"))
        dependencies = package.get("dependencies", {})
        for dependency in REQUIRED_DEPENDENCIES:
            if dependency not in dependencies:
                errors.append(f"missing dependency {dependency}")
        for dependency in FORBIDDEN_DEPENDENCIES:
            if dependency in dependencies:
                errors.append(f"removed dependency is still present: {dependency}")
        for script in ("generate", "dev", "build", "lint", "typecheck", "check"):
            if script not in package.get("scripts", {}):
                errors.append(f"missing package script {script}")

    page_path = site / "src" / "app" / "page.mdx"
    if page_path.is_file() and "<WalkthroughApp" not in page_path.read_text(encoding="utf-8"):
        errors.append("page.mdx must render WalkthroughApp")

    globals_path = site / "src" / "app" / "globals.css"
    if globals_path.is_file():
        globals_text = globals_path.read_text(encoding="utf-8")
        for marker in ('font-family: "Berkeley Mono"', "--diffs-font-family: var(--font-mono)"):
            if marker not in globals_text:
                errors.append(f"globals.css is missing {marker}")
        if "--diffs-gap-block: 8px" not in globals_text:
            errors.append("globals.css must preserve Pierre's 8px block rhythm")

    compiler_path = site / "scripts" / "compile_walkthrough.py"
    if compiler_path.is_file():
        compiler_text = compiler_path.read_text(encoding="utf-8")
        for marker in (
            "compile_guide",
            "headSha",
            "GENERIC_SUMMARY_PREFIXES",
            "needs an 8–36 word concrete summary",
            "summary must start with a subsystem or mechanism",
            "summary must add information beyond Objective",
            "classify_generated_file",
            "reject_legacy_lens_syntax",
            "MAX_EXPANDABLE_BLOB_BYTES",
            "MAX_EMBEDDED_CONTEXT_BYTES",
            "read_git_blob",
            "--include-full-context",
        ):
            if marker not in compiler_text:
                errors.append(f"walkthrough compiler is missing {marker}")

    guide_contract_path = site / "scripts" / "guide_contract.py"
    if guide_contract_path.is_file():
        guide_contract_text = guide_contract_path.read_text(encoding="utf-8")
        for marker in (
            "PHASES",
            "needs exactly one Diff directive",
            "covers changed lines more than once",
            "countsTowardCompletion",
            "guide-diagram",
            "lineNumber",
        ):
            if marker not in guide_contract_text:
                errors.append(f"Guide compiler contract is missing {marker}")

    source_root = site / "src" / "content" / "walkthrough"
    if (source_root / "lenses").exists():
        errors.append("walkthrough source must not contain the removed lenses directory")
    source_path = source_root / "index.mdx"
    source_files = list(source_root.rglob("*.mdx")) if source_root.is_dir() else []
    if source_path.is_file():
        source = source_path.read_text(encoding="utf-8")
        if "# Review guide" not in source or "- Section:" not in source:
            errors.append("walkthrough/index.mdx must define the ordered review guide")
    for section_path in source_files:
        if section_path == source_path:
            continue
        section_text = section_path.read_text(encoding="utf-8")
        if section_text.count("## Guide") != 1:
            errors.append(f"{section_path.relative_to(site)} must contain exactly one Guide section")

    data_path = site / "src" / "data" / "walkthrough.generated.json"
    if data_path.is_file():
        generated_inputs = list(source_files)
        for generated_input in (
            site / "src" / "data" / "walkthrough.patch",
            site / FULL_CONTEXT_MARKER,
        ):
            if generated_input.is_file():
                generated_inputs.append(generated_input)
        if generated_inputs and data_path.stat().st_mtime < max(
            path.stat().st_mtime for path in generated_inputs
        ):
            errors.append("generated walkthrough data is older than its canonical inputs")
        data = json.loads(data_path.read_text(encoding="utf-8"))
        if "graphs" in data:
            errors.append("walkthrough data must not contain the removed graphs output")
        meta = data.get("meta")
        if not isinstance(meta, dict) or not re.fullmatch(r"[0-9a-f]{40}", str(meta.get("headSha", ""))):
            errors.append("walkthrough data meta.headSha must be a lowercase 40-character Git SHA")
        diff_files = data.get("diffFiles")
        if not isinstance(diff_files, list):
            errors.append("walkthrough data must contain a diffFiles list")
            diff_files = []
        else:
            full_context_files: list[dict] = []
            for file in diff_files:
                if not isinstance(file.get("generated"), bool):
                    errors.append(f"diff file {file.get('path')} must contain a generated boolean")
                reason = file.get("generatedReason")
                if reason is not None and not isinstance(reason, str):
                    errors.append(f"diff file {file.get('path')} generatedReason must be text")
                old_contents = file.get("oldContents")
                new_contents = file.get("newContents")
                if (old_contents is None) != (new_contents is None):
                    errors.append(f"diff file {file.get('path')} must provide oldContents and newContents together")
                if old_contents is not None and not isinstance(old_contents, str):
                    errors.append(f"diff file {file.get('path')} oldContents must be text")
                if new_contents is not None and not isinstance(new_contents, str):
                    errors.append(f"diff file {file.get('path')} newContents must be text")
                if file.get("binary") and (old_contents is not None or new_contents is not None):
                    errors.append(f"binary diff file {file.get('path')} must not embed full context")
                if isinstance(old_contents, str) and isinstance(new_contents, str):
                    full_context_files.append(file)

            full_context_enabled = (site / FULL_CONTEXT_MARKER).is_file()
            eligible_context_files = [
                file
                for file in diff_files
                if file.get("status") in {"modified", "renamed", "copied"}
                and not file.get("binary")
            ]
            if full_context_enabled and eligible_context_files and not full_context_files:
                errors.append(
                    "full-context mode is enabled but no eligible diff has exact old/new contents"
                )
            if not full_context_enabled and full_context_files:
                errors.append(
                    "exact old/new contents require the explicit full-context marker"
                )
        review_groups = data.get("reviewGroups")
        if not isinstance(review_groups, list) or not review_groups:
            errors.append("walkthrough data must contain non-empty reviewGroups")
        else:
            group_ids = [group.get("id") for group in review_groups]
            if len(set(group_ids)) != len(group_ids):
                errors.append("reviewGroups must use unique IDs")
            guide_excerpt_ids: list[str] = []
            for group in review_groups:
                if "lenses" in group:
                    errors.append(
                        f"review group {group.get('id')} must not contain the removed lenses output"
                    )
                guide = group.get("guide")
                phases = guide.get("phases") if isinstance(guide, dict) else None
                if not isinstance(phases, list) or not phases:
                    errors.append(f"review group {group.get('id')} must contain non-empty Guide phases")
                    continue
                phase_ids = [phase.get("id") for phase in phases if isinstance(phase, dict)]
                expected_order = [phase_id for phase_id in GUIDE_PHASES if phase_id in phase_ids]
                if phase_ids != expected_order or len(phase_ids) != len(set(phase_ids)):
                    errors.append(f"review group {group.get('id')} Guide phases must be a unique canonical-order subset")
                for phase in phases:
                    phase_id = phase.get("id") if isinstance(phase, dict) else None
                    if not isinstance(phase, dict):
                        errors.append(f"review group {group.get('id')} contains an invalid Guide phase")
                        continue
                    if not isinstance(phase.get("explanation"), list) or not phase["explanation"]:
                        errors.append(f"Guide phase {phase_id} needs explanatory content")
                    if not isinstance(phase.get("defaultCollapsed"), bool):
                        errors.append(f"Guide phase {phase_id} needs a defaultCollapsed boolean")
                    diagram = phase.get("diagram")
                    if diagram is not None:
                        if not isinstance(diagram, dict) or not diagram.get("summary"):
                            errors.append(f"Guide phase {phase_id} has an invalid optional diagram")
                        elif not isinstance(diagram.get("nodes"), list) or not isinstance(diagram.get("edges"), list):
                            errors.append(f"Guide phase {phase_id} diagram needs node and edge lists")
                    excerpts = phase.get("excerpts")
                    if not isinstance(excerpts, list) or not excerpts:
                        errors.append(f"Guide phase {phase_id} must contain excerpts")
                        continue
                    for excerpt in excerpts:
                        excerpt_id = excerpt.get("id") if isinstance(excerpt, dict) else None
                        if not isinstance(excerpt, dict) or not isinstance(excerpt_id, str):
                            errors.append(f"Guide phase {phase_id} contains an invalid excerpt")
                            continue
                        guide_excerpt_ids.append(excerpt_id)
                        if not isinstance(excerpt.get("explanation"), list) or not excerpt["explanation"]:
                            errors.append(f"Guide excerpt {excerpt_id} needs explanatory content")
                        if not isinstance(excerpt.get("comments"), list):
                            errors.append(f"Guide excerpt {excerpt_id} comments must be a list")
                        excluded = bool(excerpt.get("generated") or excerpt.get("binary"))
                        if excerpt.get("countsTowardCompletion") is not (not excluded):
                            errors.append(
                                f"Guide excerpt {excerpt_id} completion eligibility must exclude only generated or binary files"
                            )
            if len(guide_excerpt_ids) != len(set(guide_excerpt_ids)):
                errors.append("Guide excerpts must use globally unique IDs")

    components_path = site / "components.json"
    if components_path.is_file():
        components = json.loads(components_path.read_text(encoding="utf-8"))
        if components.get("style") != "radix-lyra":
            errors.append("components.json must use the radix-lyra shadcn style")

    app_source = site / "src" / "components" / "walkthrough" / "walkthrough-app.tsx"
    if app_source.is_file():
        app_text = app_source.read_text(encoding="utf-8")
        markers = [
            "data-review-group-id",
            "data-file-path",
            "data-diff-path",
            "data-reviewed",
            "data-inline-evidence",
            "data-review-file-tree",
            "data-guide-document",
            "data-guide-phase-id",
            "data-guide-excerpt-id",
        ]
        if data_path.is_file() and any(
            file.get("generated") or file.get("binary")
            for file in data.get("diffFiles", [])
        ):
            markers.extend(["data-generated", "data-generated-section"])
        for marker in markers:
            component_text = "\n".join(
                path.read_text(encoding="utf-8")
                for path in (site / "src" / "components" / "walkthrough").glob("*.tsx")
            )
            if marker not in component_text:
                errors.append(f"walkthrough components are missing {marker}")

        review_document_text = (
            site / "src" / "components" / "walkthrough" / "review-document.tsx"
        ).read_text(encoding="utf-8")
        for marker in (
            "showGeneratedFiles",
            "changed-files-heading",
            "<ChangedFileTree",
            '"Show generated/binary"',
            '"Hide generated/binary"',
        ):
            if marker not in review_document_text:
                errors.append(f"review document is missing {marker}")
        if "Changed evidence" in review_document_text or "<Separator" in review_document_text:
            errors.append("Changed files must not use the removed evidence label or divider")

        changed_file_tree_text = (
            site / "src" / "components" / "walkthrough" / "changed-file-tree.tsx"
        ).read_text(encoding="utf-8")
        for marker in (
            "TREE_BORDER_WIDTH",
            "treeContentHeight + TREE_BORDER_WIDTH * 2",
            "treeCss(files)",
            'data-item-section="content"',
            "opacity: 0.5",
        ):
            if marker not in changed_file_tree_text:
                errors.append(f"changed file Tree is missing {marker}")
        if "paddingBlock" in changed_file_tree_text:
            errors.append("changed file Tree must not add block padding")

        sidebar_text = (
            site / "src" / "components" / "walkthrough" / "review-context-sidebar.tsx"
        ).read_text(encoding="utf-8")
        for removed_marker in ("<ChangedFileTree", "tests-heading", "generated-files-heading"):
            if removed_marker in sidebar_text:
                errors.append(f"supporting evidence still contains removed section marker: {removed_marker}")

        review_group_rail_text = (
            site / "src" / "components" / "walkthrough" / "review-group-rail.tsx"
        ).read_text(encoding="utf-8")
        for removed_marker in (">Active</Badge>", 'Circle className="fill-current"'):
            if removed_marker in review_group_rail_text:
                errors.append(f"review group rail still contains removed Active chip marker: {removed_marker}")
        if 'Badge className="rounded-md border-' not in review_group_rail_text:
            errors.append("review group Reviewed badge is missing the shared rounded-md radius")

        walkthrough_app_text = (
            site / "src" / "components" / "walkthrough" / "walkthrough-app.tsx"
        ).read_text(encoding="utf-8")
        if 'Button asChild className="shrink-0 rounded-md"' not in walkthrough_app_text:
            errors.append("Open PR is missing the shared rounded-md radius")
        for marker in (
            "window.localStorage.getItem",
            "window.localStorage.setItem",
            "walkthroughData.meta.headSha",
            "reviewedExcerptIds",
            "countsTowardCompletion",
            "persistenceState",
            "resetUnreadableProgress",
            "copyProgressBackup",
        ):
            if marker not in walkthrough_app_text:
                errors.append(f"walkthrough progress persistence is missing {marker}")

        for marker in (
            ">Normal</TabsTrigger>",
            ">Guide</TabsTrigger>",
            "code hunks reviewed",
            "<GuideDocument",
        ):
            if marker not in review_document_text:
                errors.append(f"review modes are missing {marker}")

        guide_diagram_text = (
            site / "src" / "components" / "walkthrough" / "guide-diagram.tsx"
        ).read_text(encoding="utf-8")
        for marker in ("ReactFlow", "fitView", "nodesDraggable={false}", "nodesConnectable={false}"):
            if marker not in guide_diagram_text:
                errors.append(f"read-only Guide diagram is missing {marker}")

        guide_document_text = (
            site / "src" / "components" / "walkthrough" / "guide-document.tsx"
        ).read_text(encoding="utf-8")
        for marker in ("Guide outline", "lineAnnotations", "renderAnnotation", "countsTowardCompletion"):
            if marker not in guide_document_text:
                errors.append(f"Guide document is missing {marker}")

        for marker in (
            "shrink-0 rounded-md",
            'className="rounded-l-md! rounded-r-none!"',
            'className="rounded-l-none! rounded-r-md!"',
        ):
            if marker not in review_document_text:
                errors.append(f"review controls are missing rounded-corner treatment: {marker}")
        for marker in (
            "border-[var(--added)]/50!",
            "bg-[var(--added)]/10!",
            'Check className="text-[var(--added)]"',
        ):
            if marker not in review_document_text:
                errors.append(f"group reviewed control is missing selected-state treatment: {marker}")

        source_diff_text = (
            site / "src" / "components" / "walkthrough" / "source-diff.tsx"
        ).read_text(encoding="utf-8")
        for marker in (
            "REVIEW_SURFACE_CLASS",
            "paddingBottom: 0",
            "metrics={DIFF_METRICS}",
            "handleDiffClick",
            'hasAttribute("data-diffs-header")',
            "event.stopPropagation()",
            "if (pressed && expanded) onToggleExpanded()",
            "onExpandedPathChange(path, !expandedPaths.has(path))",
        ):
            if marker not in source_diff_text:
                errors.append(f"source diff is missing {marker}")

        diff_options_text = (
            site / "src" / "components" / "walkthrough" / "diff-options.ts"
        ).read_text(encoding="utf-8")
        for marker in ('[data-change-icon="change"]', "--diffs-warning-dark"):
            if marker not in diff_options_text:
                errors.append(f"diff options are missing modified-file styling: {marker}")

        globals_text = (site / "src" / "app" / "globals.css").read_text(encoding="utf-8")
        for marker in ("--changed:", "--trees-git-modified-color-override: var(--changed)"):
            if marker not in globals_text:
                errors.append(f"walkthrough theme is missing modified-file styling: {marker}")

    if args.built:
        index_path = site / "out" / "index.html"
        if not index_path.is_file():
            errors.append("missing static export out/index.html")
        else:
            if source_files and index_path.stat().st_mtime < max(path.stat().st_mtime for path in source_files):
                errors.append("static export is older than canonical MDX")
            if data_path.is_file() and index_path.stat().st_mtime < data_path.stat().st_mtime:
                errors.append("static export is older than generated walkthrough data")
            html = index_path.read_text(encoding="utf-8")
            if 'src="/_next/' in html:
                errors.append("static export uses root-relative assets")
            if not any((site / "out").rglob("*.woff2")):
                errors.append("static export is missing the Berkeley Mono font assets")
            built_text = html + "\n" + "\n".join(
                path.read_text(encoding="utf-8", errors="ignore")
                for path in (site / "out" / "_next" / "static" / "chunks").glob("*.js")
            )
            labels = [
                "Changes in PR",
                "Mark Normal + Guide reviewed",
                "Open review groups",
                "Go to top",
                "Changed files",
                "Section ",
                "Normal",
                "Guide",
                "Guide outline",
                "code hunks reviewed",
            ]
            if data_path.is_file() and any(
                file.get("generated") or file.get("binary")
                for file in data.get("diffFiles", [])
            ):
                labels.append("Show generated/binary")
            for label in labels:
                if label not in built_text:
                    errors.append(f"static export is missing {label}")
            if "Open evidence" in built_text:
                errors.append("responsive evidence must be inline, not a second drawer")
            if "Evidence and context" in built_text:
                errors.append("supporting sections must not use an Evidence and context wrapper")
            if "Changed evidence" in built_text:
                errors.append("static export must use Changed files instead of Changed evidence")
            if "Go to bottom" in built_text:
                errors.append("static export must not contain a Go to bottom action")
            for removed_label in ("Active objective", "Browse all files", "data-lens-id"):
                if removed_label in built_text:
                    errors.append(f"static export still contains removed walkthrough UI: {removed_label}")
            for removed_marker in ("Context lens", "View all"):
                if removed_marker in built_text:
                    errors.append(f"static export still contains removed walkthrough marker: {removed_marker}")
            for empty_label in (
                "No focused tests",
                "No related evidence",
                "No relationship view",
                "No review notes",
            ):
                if empty_label in built_text:
                    errors.append(f"static export must omit empty section state: {empty_label}")
            if "Open file on GitHub" in built_text or "Review note for" in built_text:
                errors.append("Pierre file headers must not add external-link or information-icon controls")

    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    print("Template validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
