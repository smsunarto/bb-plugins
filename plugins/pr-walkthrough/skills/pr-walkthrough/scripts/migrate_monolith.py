#!/usr/bin/env python3
"""Split a legacy walkthrough.mdx into canonical multi-file MDX."""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path

REMOVED_DIAGRAM_HEADINGS = {
    "System overview",
    "Data flow graph",
    "Code dependency graph",
    "User action graph",
}


def reject_legacy_lenses(lines: list[str]) -> None:
    for line_number, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if line.startswith("- Lens:"):
            raise SystemExit(
                f"line {line_number} uses the removed Lens syntax; delete it and keep "
                "reviewer guidance in the relevant Review guide group before migrating"
            )
        heading = re.match(r"^# (.+?)\s*$", raw_line)
        if heading and heading.group(1) in REMOVED_DIAGRAM_HEADINGS:
            raise SystemExit(
                f"line {line_number} uses the removed diagram heading "
                f"{heading.group(1)!r}; delete that diagram and move any useful prose "
                "into the relevant Review guide group before migrating"
            )


def slug(value: str) -> str:
    result = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if not result:
        raise SystemExit(f"cannot create a filename for heading: {value}")
    return result


def first_level_sections(lines: list[str]) -> list[tuple[str, list[str]]]:
    result: list[tuple[str, list[str]]] = []
    current: tuple[str, list[str]] | None = None
    for line in lines:
        match = re.match(r"^# (.+?)\s*$", line)
        if match:
            if current:
                result.append(current)
            current = (match.group(1), [])
        elif current:
            if line.strip() != "</WalkthroughSource>":
                current[1].append(line)
    if current:
        result.append(current)
    return result


def split_groups(lines: list[str]) -> tuple[list[str], list[tuple[str, list[str]]]]:
    intro: list[str] = []
    groups: list[tuple[str, list[str]]] = []
    current: tuple[str, list[str]] | None = None
    for line in lines:
        match = re.match(r"^## (.+?)\s*$", line)
        if match:
            if current:
                groups.append(current)
            current = (match.group(1), [])
        elif current:
            current[1].append(line)
        else:
            intro.append(line)
    if current:
        groups.append(current)
    return intro, groups


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    source = args.input.read_text(encoding="utf-8")
    lines = source.splitlines()
    reject_legacy_lenses(lines)
    if not lines or lines[0].strip() != "---":
        raise SystemExit("legacy walkthrough must start with frontmatter")
    try:
        frontmatter_end = lines.index("---", 1)
    except ValueError as error:
        raise SystemExit("legacy walkthrough frontmatter is not closed") from error

    sections = first_level_sections(lines[frontmatter_end + 1 :])
    section_map = {label: body for label, body in sections}
    if "Review guide" not in section_map:
        raise SystemExit("legacy walkthrough has no Review guide")
    intro, groups = split_groups(section_map["Review guide"])
    if not groups:
        raise SystemExit("legacy Review guide has no groups")

    output = args.output.resolve()
    if output.exists():
        if not args.force:
            raise SystemExit(f"output already exists: {output}")
        shutil.rmtree(output)
    (output / "sections").mkdir(parents=True)

    manifest = [*lines[: frontmatter_end + 1], "", "# Review guide", *intro]
    for index, (title, body) in enumerate(groups, start=1):
        relative = f"sections/{index:02d}-{slug(title)}.mdx"
        manifest.append(f"- Section: [{title}]({relative})")
        (output / relative).write_text(
            "\n".join([f"# {title}", *body]).rstrip() + "\n",
            encoding="utf-8",
        )

    (output / "index.mdx").write_text("\n".join(manifest).rstrip() + "\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
