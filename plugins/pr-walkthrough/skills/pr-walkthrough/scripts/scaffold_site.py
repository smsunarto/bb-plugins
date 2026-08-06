#!/usr/bin/env python3
"""Create or refresh a PR walkthrough site from the reusable template."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

OBSOLETE_TEMPLATE_PATHS = (
    "design-qa.md",
    "src/components/ui/card.tsx",
    "src/components/walkthrough/diff-browser.tsx",
    "src/components/walkthrough/graph-canvas.tsx",
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--content",
        type=Path,
        help="Canonical walkthrough MDX directory. If omitted, the template includes sample Markdown.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(".pr-walkthrough/site"),
        help="Site source directory (default: .pr-walkthrough/site).",
    )
    parser.add_argument(
        "--diff",
        type=Path,
        help="Unified Git patch used for the changed-file tree and source diff view.",
    )
    parser.add_argument(
        "--include-full-context",
        action="store_true",
        help=(
            "Embed exact old/new Git blobs for native hunk expansion. "
            "The generated artifact must remain localhost-only."
        ),
    )
    args = parser.parse_args()

    template = Path(__file__).resolve().parent.parent / "assets" / "site-template"
    if not template.is_dir():
        raise SystemExit(f"template not found: {template}")

    if args.content and not args.content.is_dir():
        raise SystemExit("--content must be a directory containing index.mdx")
    if args.content and not (args.content / "index.mdx").is_file():
        raise SystemExit("--content must contain index.mdx")
    if args.diff and not args.diff.is_file():
        raise SystemExit(f"--diff file not found: {args.diff}")

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    for relative_path in OBSOLETE_TEMPLATE_PATHS:
        stale_path = output / relative_path
        if stale_path.is_dir():
            shutil.rmtree(stale_path)
        else:
            stale_path.unlink(missing_ok=True)
    shutil.copytree(
        template,
        output,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("node_modules", ".next", "out", "__pycache__", "*.tsbuildinfo"),
    )

    if args.content:
        target = output / "src" / "content" / "walkthrough"
        shutil.rmtree(target, ignore_errors=True)
        shutil.copytree(args.content, target)

    patch_target = output / "src" / "data" / "walkthrough.patch"
    if args.diff:
        shutil.copyfile(args.diff, patch_target)
    elif args.content:
        patch_target.write_text("", encoding="utf-8")

    full_context_marker = output / "src" / "data" / "full-context.enabled"
    if args.include_full_context:
        full_context_marker.write_text("localhost-only\n", encoding="utf-8")
    else:
        full_context_marker.unlink(missing_ok=True)
        shutil.rmtree(output / ".next", ignore_errors=True)
        shutil.rmtree(output / "out", ignore_errors=True)

    try:
        subprocess.run(
            [sys.executable, "scripts/compile_walkthrough.py"],
            cwd=output,
            check=True,
        )
    except subprocess.CalledProcessError as error:
        raise SystemExit("walkthrough MDX compilation failed") from error

    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
