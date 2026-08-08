#!/usr/bin/env python3
"""Parse and validate Guide-mode MDX against an exact Git patch."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import re
from typing import Literal


PHASES: tuple[tuple[str, str], ...] = (
    ("foundations", "Foundations and data structures"),
    ("apis", "APIs and entrypoints"),
    ("behavior", "Core behavior"),
    ("integration", "Integration and wiring"),
    ("tests", "Tests and verification"),
    ("misc", "Imports, formatting, and miscellaneous"),
    ("generated", "Generated output"),
)
PHASE_BY_TITLE = {title: (index, phase_id) for index, (phase_id, title) in enumerate(PHASES)}

GUIDE_HEADING = "## Guide"
PHASE_HEADING = re.compile(r"^### (.+?)\s*$")
EXCERPT_HEADING = re.compile(r"^#### (.+?)\s*$")
DIFF_DIRECTIVE = re.compile(
    r"^- Diff: `([a-z0-9][a-z0-9-]*)` \[([^]]+)]\(([^)]+)\)\s*$"
)
CONTEXT_DIRECTIVE = re.compile(r"^- Context: `([0-9]+)`\s*$")
COMMENT_DIRECTIVE = re.compile(r"^- Comment: ([LR])([0-9]+) — (.+?)\s*$")
SELECTOR = re.compile(r"^([LR])([0-9]+)(?:-([LR]?)([0-9]+))?$")
HUNK_HEADER = re.compile(
    r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$"
)
KEBAB_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
DIAGRAM_NODE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")

LineSide = Literal["deletions", "additions"]


class GuideCompileError(ValueError):
    """Raised when the canonical Guide contract is invalid."""


@dataclass(frozen=True, order=True)
class LineRef:
    side: LineSide
    line_number: int


@dataclass(frozen=True)
class PatchRow:
    kind: Literal["context", "deletion", "addition", "no-newline"]
    raw: str
    old_line: int | None
    new_line: int | None
    old_before: int
    new_before: int

    @property
    def changed_ref(self) -> LineRef | None:
        if self.kind == "deletion" and self.old_line is not None:
            return LineRef("deletions", self.old_line)
        if self.kind == "addition" and self.new_line is not None:
            return LineRef("additions", self.new_line)
        return None


@dataclass(frozen=True)
class PatchHunk:
    suffix: str
    rows: tuple[PatchRow, ...]


@dataclass(frozen=True)
class IndexedPatchFile:
    path: str
    prelude: tuple[str, ...]
    hunks: tuple[PatchHunk, ...]
    original_patch: str

    @property
    def changed_refs(self) -> frozenset[LineRef]:
        return frozenset(
            ref
            for hunk in self.hunks
            for row in hunk.rows
            if (ref := row.changed_ref) is not None
        )


@dataclass(frozen=True)
class ParsedSelector:
    refs: tuple[LineRef, ...] | None


def split_guide_section(lines: list[str], context: str) -> tuple[list[str], list[str]]:
    """Split one section into its unchanged Normal source and required Guide source."""

    matches: list[int] = []
    in_fence = False
    for index, line in enumerate(lines):
        if line.strip().startswith("```"):
            in_fence = not in_fence
        elif not in_fence and line.strip() == GUIDE_HEADING:
            matches.append(index)
    if in_fence:
        raise GuideCompileError(f"{context} has an unterminated code fence")
    if not matches:
        raise GuideCompileError(f"{context} needs exactly one {GUIDE_HEADING} heading")
    if len(matches) > 1:
        raise GuideCompileError(f"{context} repeats the {GUIDE_HEADING} heading")
    index = matches[0]
    return lines[:index], lines[index + 1 :]


def _strip_git_prefix(path: str) -> str:
    return path[2:] if path.startswith(("a/", "b/")) else path


def decode_git_path(value: str) -> str:
    """Decode one Git C-quoted, byte-oriented path without destabilizing bad input."""

    if not value.startswith('"'):
        return value
    if len(value) < 2 or not value.endswith('"'):
        return value
    payload = value[1:-1]
    decoded = bytearray()
    index = 0
    escapes = {
        "a": 0x07,
        "b": 0x08,
        "t": 0x09,
        "n": 0x0A,
        "v": 0x0B,
        "f": 0x0C,
        "r": 0x0D,
        "\\": 0x5C,
        '"': 0x22,
    }
    try:
        while index < len(payload):
            character = payload[index]
            if character != "\\":
                decoded.extend(character.encode("utf-8"))
                index += 1
                continue
            index += 1
            if index >= len(payload):
                return value
            escaped = payload[index]
            if escaped in escapes:
                decoded.append(escapes[escaped])
                index += 1
                continue
            if escaped in "01234567":
                end = index + 1
                while end < min(index + 3, len(payload)) and payload[end] in "01234567":
                    end += 1
                decoded.append(int(payload[index:end], 8))
                index = end
                continue
            return value
        return decoded.decode("utf-8")
    except (UnicodeDecodeError, UnicodeEncodeError, ValueError):
        return value


def decode_git_metadata_path(value: str) -> str:
    """Decode metadata paths while preserving spaces in their unquoted form."""

    return decode_git_path(value)


def parse_git_diff_header(line: str) -> tuple[str, str]:
    prefix = "diff --git "
    if not line.startswith(prefix):
        return "", ""
    remainder = line[len(prefix):]
    if remainder.startswith('"'):
        escaped = False
        for index, character in enumerate(remainder[1:], start=1):
            if character == '"' and not escaped:
                old_field = remainder[: index + 1]
                new_field = remainder[index + 1 :].lstrip()
                if not new_field:
                    return "", ""
                return (
                    _strip_git_prefix(decode_git_path(old_field)),
                    _strip_git_prefix(decode_git_path(new_field)),
                )
            if character == "\\" and not escaped:
                escaped = True
            else:
                escaped = False
        return "", ""

    candidates: list[tuple[str, str]] = []
    offset = 0
    while (separator := remainder.find(" b/", offset)) >= 0:
        old_field = remainder[:separator]
        new_field = remainder[separator + 1 :]
        candidates.append((old_field, new_field))
        offset = separator + 1
    if not candidates:
        return "", ""
    old_field, new_field = next(
        (
            candidate
            for candidate in candidates
            if _strip_git_prefix(candidate[0]) == _strip_git_prefix(candidate[1])
        ),
        candidates[-1],
    )
    return _strip_git_prefix(old_field), _strip_git_prefix(decode_git_path(new_field))


def decode_git_marker_path(value: str) -> str:
    """Decode one ---/+++ path, including Git's tab delimiter for paths with spaces."""

    decoded = decode_git_path(value.removesuffix("\t"))
    return "" if decoded == "/dev/null" else _strip_git_prefix(decoded)


def _index_patch_block(block: str) -> IndexedPatchFile | None:
    lines = block.rstrip("\n").split("\n")
    if not lines or not lines[0].startswith("diff --git "):
        return None
    old_path, new_path = parse_git_diff_header(lines[0])
    first_hunk = next((index for index, line in enumerate(lines) if line.startswith("@@ ")), len(lines))
    status = "modified"
    rename_to = ""
    copied_to = ""
    for line in lines[1:first_hunk]:
        if line.startswith("new file mode "):
            status = "added"
        elif line.startswith("deleted file mode "):
            status = "deleted"
        elif line.startswith("--- "):
            old_path = decode_git_marker_path(line.removeprefix("--- "))
        elif line.startswith("+++ "):
            new_path = decode_git_marker_path(line.removeprefix("+++ "))
        elif line.startswith("rename to "):
            rename_to = decode_git_metadata_path(line.removeprefix("rename to "))
            status = "renamed"
        elif line.startswith("copy to "):
            copied_to = decode_git_metadata_path(line.removeprefix("copy to "))
            status = "copied"
    path = rename_to or copied_to or (old_path if status == "deleted" else new_path)
    if not path:
        return None

    prelude = tuple(lines[:first_hunk])
    hunks: list[PatchHunk] = []
    index = first_hunk
    while index < len(lines):
        match = HUNK_HEADER.match(lines[index])
        if not match:
            raise GuideCompileError(f"patch for {path} contains an invalid hunk header: {lines[index]}")
        old_start, _old_count, new_start, _new_count, suffix = match.groups()
        old_cursor = int(old_start)
        new_cursor = int(new_start)
        index += 1
        rows: list[PatchRow] = []
        while index < len(lines) and not lines[index].startswith("@@ "):
            raw = lines[index]
            old_before = max(0, old_cursor - 1)
            new_before = max(0, new_cursor - 1)
            if raw.startswith(" "):
                rows.append(PatchRow("context", raw, old_cursor, new_cursor, old_before, new_before))
                old_cursor += 1
                new_cursor += 1
            elif raw.startswith("-"):
                rows.append(PatchRow("deletion", raw, old_cursor, None, old_before, new_before))
                old_cursor += 1
            elif raw.startswith("+"):
                rows.append(PatchRow("addition", raw, None, new_cursor, old_before, new_before))
                new_cursor += 1
            elif raw.startswith("\\ No newline at end of file"):
                rows.append(PatchRow("no-newline", raw, None, None, old_before, new_before))
            else:
                raise GuideCompileError(f"patch for {path} contains an invalid hunk row: {raw}")
            index += 1
        hunks.append(PatchHunk(suffix, tuple(rows)))
    return IndexedPatchFile(path, prelude, tuple(hunks), block.rstrip("\n") + "\n")


def index_patch(patch: str) -> dict[str, IndexedPatchFile]:
    result: dict[str, IndexedPatchFile] = {}
    for block in re.split(r"(?=^diff --git )", patch, flags=re.MULTILINE):
        indexed = _index_patch_block(block) if block.startswith("diff --git ") else None
        if indexed is None:
            continue
        if indexed.path in result:
            raise GuideCompileError(f"patch repeats changed file {indexed.path}")
        result[indexed.path] = indexed
    return result


def _parse_selector(target: str, context: str) -> ParsedSelector:
    if target == "-":
        return ParsedSelector(None)
    if not target.startswith("#") or len(target) == 1:
        raise GuideCompileError(
            f"{context} Diff target must be - or changed-line selectors such as #L10-L12,R10-R13"
        )
    refs: list[LineRef] = []
    for token in target[1:].split(","):
        match = SELECTOR.fullmatch(token)
        if not match:
            raise GuideCompileError(f"{context} has an invalid changed-line selector: {token}")
        side_token, start_token, end_side_token, end_token = match.groups()
        if end_side_token and end_side_token != side_token:
            raise GuideCompileError(f"{context} crosses line sides inside one range: {token}")
        start = int(start_token)
        end = int(end_token or start_token)
        if start < 1 or end < start:
            raise GuideCompileError(f"{context} has an invalid changed-line range: {token}")
        if end - start > 10_000:
            raise GuideCompileError(f"{context} changed-line range is unreasonably large: {token}")
        side: LineSide = "deletions" if side_token == "L" else "additions"
        refs.extend(LineRef(side, line_number) for line_number in range(start, end + 1))
    if len(set(refs)) != len(refs):
        raise GuideCompileError(f"{context} repeats a changed-line selector")
    return ParsedSelector(tuple(refs))


def _format_range_label(refs: tuple[LineRef, ...] | None) -> str:
    if refs is None:
        return "Whole file"
    groups: list[str] = []
    for side, prefix in (("deletions", "L"), ("additions", "R")):
        numbers = sorted({ref.line_number for ref in refs if ref.side == side})
        ranges: list[str] = []
        start_index = 0
        while start_index < len(numbers):
            end_index = start_index
            while end_index + 1 < len(numbers) and numbers[end_index + 1] == numbers[end_index] + 1:
                end_index += 1
            start = numbers[start_index]
            end = numbers[end_index]
            ranges.append(f"{prefix}{start}" if start == end else f"{prefix}{start}–{end}")
            start_index = end_index + 1
        if ranges:
            groups.append(", ".join(ranges))
    return " · ".join(groups)


def _line_ref_json(ref: LineRef) -> tuple[str, int]:
    return ref.side, ref.line_number


def _visible_refs(rows: list[PatchRow]) -> set[LineRef]:
    result: set[LineRef] = set()
    for row in rows:
        if row.kind == "deletion" and row.old_line is not None:
            result.add(LineRef("deletions", row.old_line))
        elif row.kind == "addition" and row.new_line is not None:
            result.add(LineRef("additions", row.new_line))
        elif row.kind == "context" and row.old_line is not None and row.new_line is not None:
            result.add(LineRef("deletions", row.old_line))
            result.add(LineRef("additions", row.new_line))
    return result


def _synthetic_hunk(hunk: PatchHunk, refs: set[LineRef], context_lines: int) -> tuple[list[str], set[LineRef]]:
    rows = list(hunk.rows)
    selected_indices = [index for index, row in enumerate(rows) if row.changed_ref in refs]
    if not selected_indices:
        return [], set()

    intervals: list[tuple[int, int]] = []
    for selected in selected_indices:
        left = selected
        remaining = context_lines
        cursor = selected - 1
        while cursor >= 0 and remaining > 0:
            row = rows[cursor]
            if row.kind == "no-newline":
                cursor -= 1
                continue
            if row.kind != "context":
                break
            left = cursor
            remaining -= 1
            cursor -= 1

        right = selected
        remaining = context_lines
        cursor = selected + 1
        while cursor < len(rows) and remaining > 0:
            row = rows[cursor]
            if row.kind == "no-newline":
                right = cursor
                cursor += 1
                continue
            if row.kind != "context":
                break
            right = cursor
            remaining -= 1
            cursor += 1
        if right + 1 < len(rows) and rows[right + 1].kind == "no-newline":
            right += 1
        intervals.append((left, right))

    intervals.sort()
    merged: list[tuple[int, int]] = []
    for left, right in intervals:
        if not merged or left > merged[-1][1] + 1:
            merged.append((left, right))
        else:
            merged[-1] = (merged[-1][0], max(merged[-1][1], right))

    rendered: list[str] = []
    visible: set[LineRef] = set()
    for left, right in merged:
        selected_rows = rows[left : right + 1]
        content_rows = [row for row in selected_rows if row.kind != "no-newline"]
        if not content_rows:
            continue
        old_rows = [row for row in content_rows if row.old_line is not None]
        new_rows = [row for row in content_rows if row.new_line is not None]
        first = content_rows[0]
        old_start = old_rows[0].old_line if old_rows else first.old_before
        new_start = new_rows[0].new_line if new_rows else first.new_before
        rendered.append(
            f"@@ -{old_start},{len(old_rows)} +{new_start},{len(new_rows)} @@{hunk.suffix}"
        )
        rendered.extend(row.raw for row in selected_rows)
        visible.update(_visible_refs(selected_rows))
    return rendered, visible


def synthesize_patch(
    indexed: IndexedPatchFile,
    refs: tuple[LineRef, ...],
    context_lines: int,
) -> tuple[str, set[LineRef]]:
    selected = set(refs)
    rendered_hunks: list[str] = []
    visible: set[LineRef] = set()
    for hunk in indexed.hunks:
        rendered, hunk_visible = _synthetic_hunk(hunk, selected, context_lines)
        rendered_hunks.extend(rendered)
        visible.update(hunk_visible)
    rendered_changed = {
        ref
        for ref in visible
        if ref in indexed.changed_refs
    }
    if rendered_changed != selected:
        missing = sorted(selected - rendered_changed)
        raise GuideCompileError(
            f"failed to synthesize exact excerpt for {indexed.path}; missing {missing}"
        )
    output = [*indexed.prelude, *rendered_hunks]
    return "\n".join(output).rstrip("\n") + "\n", visible


def _is_fence(line: str) -> bool:
    return line.strip().startswith("```")


def _parse_explanation_blocks(lines: list[str], context: str) -> list[dict]:
    blocks: list[dict] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if not stripped:
            index += 1
            continue
        if stripped.startswith("```"):
            language = stripped[3:].strip()
            code: list[str] = []
            index += 1
            while index < len(lines) and lines[index].strip() != "```":
                code.append(lines[index])
                index += 1
            if index >= len(lines):
                raise GuideCompileError(f"{context} has an unterminated code fence")
            if language == "guide-diagram":
                raise GuideCompileError(f"{context} may not place a guide-diagram inside an excerpt")
            block: dict = {"type": "code", "code": "\n".join(code)}
            if language:
                block["language"] = language
            blocks.append(block)
            index += 1
            continue
        unordered = re.match(r"^[-*] (.+)$", stripped)
        ordered = re.match(r"^[0-9]+\. (.+)$", stripped)
        if unordered or ordered:
            is_ordered = ordered is not None
            items: list[str] = []
            while index < len(lines):
                candidate = lines[index].strip()
                match = re.match(r"^[0-9]+\. (.+)$", candidate) if is_ordered else re.match(r"^[-*] (.+)$", candidate)
                if not match:
                    break
                items.append(match.group(1))
                index += 1
            blocks.append({"type": "list", "ordered": is_ordered, "items": items})
            continue
        if stripped.startswith(">"):
            quote: list[str] = []
            while index < len(lines) and lines[index].strip().startswith(">"):
                quote.append(lines[index].strip().removeprefix(">").lstrip())
                index += 1
            blocks.append({"type": "quote", "text": " ".join(quote)})
            continue

        paragraph = [stripped]
        index += 1
        while index < len(lines):
            candidate = lines[index].strip()
            if (
                not candidate
                or _is_fence(candidate)
                or re.match(r"^[-*] ", candidate)
                or re.match(r"^[0-9]+\. ", candidate)
                or candidate.startswith(">")
            ):
                break
            paragraph.append(candidate)
            index += 1
        blocks.append({"type": "paragraph", "text": " ".join(paragraph)})
    if not blocks:
        raise GuideCompileError(f"{context} needs explanatory Markdown")
    return blocks


def _validate_diagram(payload: object, context: str) -> dict:
    if not isinstance(payload, dict):
        raise GuideCompileError(f"{context} guide-diagram must contain one JSON object")
    unknown = set(payload) - {"summary", "nodes", "edges"}
    if unknown:
        raise GuideCompileError(f"{context} guide-diagram has unsupported keys: {', '.join(sorted(unknown))}")
    summary = payload.get("summary")
    nodes = payload.get("nodes")
    edges = payload.get("edges")
    if not isinstance(summary, str) or not summary.strip():
        raise GuideCompileError(f"{context} guide-diagram needs a text summary")
    if not isinstance(nodes, list) or len(nodes) < 2:
        raise GuideCompileError(f"{context} guide-diagram needs at least two nodes")
    if not isinstance(edges, list) or not edges:
        raise GuideCompileError(f"{context} guide-diagram needs at least one edge")

    compiled_nodes: list[dict] = []
    node_ids: set[str] = set()
    for index, node in enumerate(nodes, start=1):
        if not isinstance(node, dict) or set(node) - {"id", "label", "detail", "x", "y"}:
            raise GuideCompileError(f"{context} guide-diagram node {index} has invalid fields")
        node_id = node.get("id")
        label = node.get("label")
        detail = node.get("detail")
        x = node.get("x")
        y = node.get("y")
        if not isinstance(node_id, str) or not DIAGRAM_NODE_ID.fullmatch(node_id):
            raise GuideCompileError(f"{context} guide-diagram node {index} needs a stable id")
        if node_id in node_ids:
            raise GuideCompileError(f"{context} guide-diagram repeats node id {node_id}")
        if not isinstance(label, str) or not label.strip():
            raise GuideCompileError(f"{context} guide-diagram node {node_id} needs a label")
        if detail is not None and not isinstance(detail, str):
            raise GuideCompileError(f"{context} guide-diagram node {node_id} detail must be text")
        if (
            isinstance(x, bool)
            or isinstance(y, bool)
            or not isinstance(x, (int, float))
            or not isinstance(y, (int, float))
            or not math.isfinite(x)
            or not math.isfinite(y)
        ):
            raise GuideCompileError(f"{context} guide-diagram node {node_id} needs finite x/y coordinates")
        compiled = {"id": node_id, "label": label.strip(), "x": x, "y": y}
        if detail:
            compiled["detail"] = detail.strip()
        compiled_nodes.append(compiled)
        node_ids.add(node_id)

    compiled_edges: list[dict] = []
    seen_edges: set[tuple[str, str, str]] = set()
    for index, edge in enumerate(edges, start=1):
        if not isinstance(edge, dict) or set(edge) - {"source", "target", "label"}:
            raise GuideCompileError(f"{context} guide-diagram edge {index} has invalid fields")
        source = edge.get("source")
        target = edge.get("target")
        label = edge.get("label")
        if not isinstance(source, str) or source not in node_ids:
            raise GuideCompileError(f"{context} guide-diagram edge {index} has unknown source")
        if not isinstance(target, str) or target not in node_ids:
            raise GuideCompileError(f"{context} guide-diagram edge {index} has unknown target")
        if label is not None and not isinstance(label, str):
            raise GuideCompileError(f"{context} guide-diagram edge {index} label must be text")
        signature = (source, target, label or "")
        if signature in seen_edges:
            raise GuideCompileError(f"{context} guide-diagram repeats an edge")
        edge_id = hashlib.sha256(f"{source}\0{target}\0{label or ''}".encode()).hexdigest()[:12]
        compiled = {"id": f"edge-{edge_id}", "source": source, "target": target}
        if label:
            compiled["label"] = label.strip()
        compiled_edges.append(compiled)
        seen_edges.add(signature)
    return {"summary": summary.strip(), "nodes": compiled_nodes, "edges": compiled_edges}


def _extract_diagram(lines: list[str], context: str) -> tuple[list[str], dict | None]:
    remaining: list[str] = []
    diagram: dict | None = None
    index = 0
    while index < len(lines):
        if lines[index].strip() != "```guide-diagram":
            remaining.append(lines[index])
            index += 1
            continue
        if diagram is not None:
            raise GuideCompileError(f"{context} may contain at most one guide-diagram")
        payload_lines: list[str] = []
        index += 1
        while index < len(lines) and lines[index].strip() != "```":
            payload_lines.append(lines[index])
            index += 1
        if index >= len(lines):
            raise GuideCompileError(f"{context} has an unterminated guide-diagram")
        try:
            payload = json.loads("\n".join(payload_lines))
        except json.JSONDecodeError as error:
            raise GuideCompileError(f"{context} guide-diagram is invalid JSON: {error.msg}") from error
        diagram = _validate_diagram(payload, context)
        remaining.append("")
        index += 1
    return remaining, diagram


def _split_sections(lines: list[str], pattern: re.Pattern[str], context: str) -> tuple[list[str], list[tuple[str, list[str]]]]:
    prelude: list[str] = []
    sections: list[tuple[str, list[str]]] = []
    current: tuple[str, list[str]] | None = None
    in_fence = False
    for line in lines:
        if line.strip().startswith("```"):
            in_fence = not in_fence
        match = None if in_fence else pattern.match(line)
        if match:
            if current is not None:
                sections.append(current)
            current = (match.group(1), [])
        elif current is None:
            prelude.append(line)
        else:
            current[1].append(line)
    if in_fence:
        raise GuideCompileError(f"{context} has an unterminated code fence")
    if current is not None:
        sections.append(current)
    return prelude, sections


def _parse_excerpt(
    title: str,
    lines: list[str],
    *,
    group_id: str,
    phase_id: str,
    group_paths: set[str],
    diff_by_path: dict[str, dict],
    patch_by_path: dict[str, IndexedPatchFile],
) -> tuple[dict, set[LineRef]]:
    local_id = ""
    path = ""
    target = ""
    context_lines = 3
    context_seen = False
    comments: list[tuple[LineRef, str]] = []
    explanation_lines: list[str] = []
    in_fence = False
    for raw_line in lines:
        stripped = raw_line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            explanation_lines.append(raw_line)
            continue
        if not in_fence and (match := DIFF_DIRECTIVE.fullmatch(stripped)):
            if local_id:
                raise GuideCompileError(f"Guide excerpt {title} repeats its Diff directive")
            local_id, path, target = match.groups()
            continue
        if not in_fence and (match := CONTEXT_DIRECTIVE.fullmatch(stripped)):
            if context_seen:
                raise GuideCompileError(f"Guide excerpt {title} repeats its Context directive")
            context_lines = int(match.group(1))
            context_seen = True
            if not 0 <= context_lines <= 8:
                raise GuideCompileError(f"Guide excerpt {title} Context must be between 0 and 8")
            continue
        if not in_fence and (match := COMMENT_DIRECTIVE.fullmatch(stripped)):
            side_token, line_token, body = match.groups()
            if int(line_token) < 1 or not body.strip():
                raise GuideCompileError(f"Guide excerpt {title} Comment needs a positive line and non-empty body")
            side: LineSide = "deletions" if side_token == "L" else "additions"
            comments.append((LineRef(side, int(line_token)), body.strip()))
            continue
        if not in_fence and stripped.startswith(("- Diff:", "- Context:", "- Comment:")):
            directive = stripped.split(":", 1)[0].removeprefix("- ")
            raise GuideCompileError(f"Guide excerpt {title} has invalid {directive} directive syntax")
        explanation_lines.append(raw_line)

    if in_fence:
        raise GuideCompileError(f"Guide excerpt {title} has an unterminated code fence")

    if not local_id:
        raise GuideCompileError(f"Guide excerpt {title} needs exactly one Diff directive")
    if path not in group_paths:
        raise GuideCompileError(f"Guide excerpt {local_id} references a file outside review group {group_id}: {path}")
    if path not in diff_by_path or path not in patch_by_path:
        raise GuideCompileError(f"Guide excerpt {local_id} references a file missing from the patch: {path}")
    explanation = _parse_explanation_blocks(explanation_lines, f"Guide excerpt {local_id}")
    parsed_selector = _parse_selector(target, f"Guide excerpt {local_id}")
    indexed = patch_by_path[path]
    diff_file = diff_by_path[path]
    is_generated = bool(diff_file.get("generated"))
    is_binary = bool(diff_file.get("binary"))
    changed_refs = indexed.changed_refs

    refs = parsed_selector.refs
    if is_generated or is_binary:
        if phase_id != "generated" or refs is not None:
            raise GuideCompileError(
                f"Guide excerpt {local_id} must place generated/binary file {path} as one whole-file item in Generated output"
            )
    elif not changed_refs:
        if phase_id != "misc" or refs is not None:
            raise GuideCompileError(
                f"Guide excerpt {local_id} must place zero-line file {path} as one whole-file item in Imports, formatting, and miscellaneous"
            )
    elif refs is None:
        raise GuideCompileError(f"Guide excerpt {local_id} must select exact changed lines for {path}")
    elif phase_id == "generated":
        raise GuideCompileError(
            f"Guide excerpt {local_id} may place only generated or binary files in Generated output"
        )

    if refs is not None:
        unknown = set(refs) - changed_refs
        if unknown:
            formatted = ", ".join(
                f"{'L' if ref.side == 'deletions' else 'R'}{ref.line_number}"
                for ref in sorted(unknown)
            )
            raise GuideCompileError(f"Guide excerpt {local_id} selects unchanged or missing lines: {formatted}")
        excerpt_patch, visible = synthesize_patch(indexed, refs, context_lines)
        additions = sum(ref.side == "additions" for ref in refs)
        deletions = sum(ref.side == "deletions" for ref in refs)
        covered_refs = set(refs)
    else:
        excerpt_patch = indexed.original_patch
        additions = int(diff_file.get("additions", 0))
        deletions = int(diff_file.get("deletions", 0))
        visible = _visible_refs([row for hunk in indexed.hunks for row in hunk.rows])
        covered_refs = set(changed_refs)

    if refs is None and comments:
        raise GuideCompileError(f"Guide excerpt {local_id} may not annotate a whole-file item")
    comment_anchors = [anchor for anchor, _body in comments]
    if len(set(comment_anchors)) != len(comment_anchors):
        raise GuideCompileError(f"Guide excerpt {local_id} repeats a line comment anchor")
    unknown_anchors = set(comment_anchors) - visible
    if unknown_anchors:
        formatted = ", ".join(
            f"{'L' if ref.side == 'deletions' else 'R'}{ref.line_number}"
            for ref in sorted(unknown_anchors)
        )
        raise GuideCompileError(f"Guide excerpt {local_id} comments on lines outside its rendered patch: {formatted}")

    excerpt_id = f"{group_id}/{local_id}"
    compiled_comments = []
    for anchor, body in comments:
        side_token = "L" if anchor.side == "deletions" else "R"
        compiled_comments.append(
            {
                "id": f"{excerpt_id}/comment/{side_token}{anchor.line_number}",
                "side": anchor.side,
                "lineNumber": anchor.line_number,
                "body": body,
            }
        )
    counts_toward_completion = not is_generated and not is_binary
    return (
        {
            "id": excerpt_id,
            "title": title,
            "explanation": explanation,
            "path": path,
            "url": diff_file.get("url", ""),
            "patch": excerpt_patch,
            "rangeLabel": _format_range_label(refs),
            "additions": additions,
            "deletions": deletions,
            "binary": is_binary,
            "generated": is_generated,
            "countsTowardCompletion": counts_toward_completion,
            "defaultCollapsed": is_generated or is_binary or phase_id in {"misc", "generated"},
            "comments": compiled_comments,
        },
        covered_refs,
    )


def compile_guide(
    guide_lines: list[str],
    *,
    group_id: str,
    group_paths: set[str],
    diff_files: list[dict],
    patch: str,
) -> dict:
    """Compile one required Guide block and prove exact patch coverage."""

    prelude, phase_sections = _split_sections(guide_lines, PHASE_HEADING, f"Guide for {group_id}")
    if any(line.strip() for line in prelude):
        raise GuideCompileError(f"Guide for {group_id} may not contain content before its first phase")
    if not phase_sections:
        raise GuideCompileError(f"Guide for {group_id} needs at least one phase")

    diff_by_path = {item["path"]: item for item in diff_files}
    patch_by_path = index_patch(patch)
    phases: list[dict] = []
    seen_phase_titles: set[str] = set()
    seen_excerpt_ids: set[str] = set()
    covered_by_path: dict[str, set[LineRef]] = {path: set() for path in group_paths}
    whole_file_counts: dict[str, int] = {path: 0 for path in group_paths}
    previous_phase_index = -1

    for phase_title, phase_lines in phase_sections:
        if phase_title not in PHASE_BY_TITLE:
            allowed = ", ".join(title for _phase_id, title in PHASES)
            raise GuideCompileError(f"Guide for {group_id} has unsupported phase {phase_title!r}; use one of: {allowed}")
        if phase_title in seen_phase_titles:
            raise GuideCompileError(f"Guide for {group_id} repeats phase {phase_title}")
        phase_index, phase_id = PHASE_BY_TITLE[phase_title]
        if phase_index <= previous_phase_index:
            raise GuideCompileError(f"Guide for {group_id} phases must follow the canonical order")
        previous_phase_index = phase_index
        seen_phase_titles.add(phase_title)

        phase_without_diagram, diagram = _extract_diagram(
            phase_lines,
            f"Guide phase {phase_title} in {group_id}",
        )
        phase_prelude, excerpt_sections = _split_sections(
            phase_without_diagram,
            EXCERPT_HEADING,
            f"Guide phase {phase_title} in {group_id}",
        )
        if not excerpt_sections:
            raise GuideCompileError(f"Guide phase {phase_title} in {group_id} needs at least one excerpt")
        explanation = _parse_explanation_blocks(phase_prelude, f"Guide phase {phase_title} in {group_id}")

        compiled_excerpts: list[dict] = []
        for excerpt_title, excerpt_lines in excerpt_sections:
            excerpt, covered_refs = _parse_excerpt(
                excerpt_title,
                excerpt_lines,
                group_id=group_id,
                phase_id=phase_id,
                group_paths=group_paths,
                diff_by_path=diff_by_path,
                patch_by_path=patch_by_path,
            )
            excerpt_id = excerpt["id"]
            if excerpt_id in seen_excerpt_ids:
                raise GuideCompileError(f"Guide for {group_id} repeats excerpt ID {excerpt_id.rsplit('/', 1)[-1]}")
            seen_excerpt_ids.add(excerpt_id)
            path = excerpt["path"]
            indexed = patch_by_path[path]
            if excerpt["rangeLabel"] == "Whole file":
                whole_file_counts[path] += 1
            overlap = covered_by_path[path] & covered_refs
            if overlap:
                formatted = ", ".join(
                    f"{'L' if ref.side == 'deletions' else 'R'}{ref.line_number}"
                    for ref in sorted(overlap)
                )
                raise GuideCompileError(f"Guide for {group_id} covers changed lines more than once in {path}: {formatted}")
            covered_by_path[path].update(covered_refs)
            compiled_excerpts.append(excerpt)

        phase: dict = {
            "id": phase_id,
            "title": phase_title,
            "explanation": explanation,
            "excerpts": compiled_excerpts,
            "defaultCollapsed": phase_id in {"misc", "generated"},
        }
        if diagram is not None:
            phase["diagram"] = diagram
        phases.append(phase)

    for path in sorted(group_paths):
        if path not in diff_by_path or path not in patch_by_path:
            raise GuideCompileError(f"Guide for {group_id} cannot validate missing patch file {path}")
        diff_file = diff_by_path[path]
        indexed = patch_by_path[path]
        special_whole_file = bool(diff_file.get("generated") or diff_file.get("binary") or not indexed.changed_refs)
        if special_whole_file:
            if whole_file_counts[path] != 1:
                raise GuideCompileError(f"Guide for {group_id} must cover {path} with exactly one whole-file item")
            continue
        missing = indexed.changed_refs - covered_by_path[path]
        extra = covered_by_path[path] - indexed.changed_refs
        if missing or extra:
            parts: list[str] = []
            if missing:
                parts.append(
                    "missing " + ", ".join(
                        f"{'L' if ref.side == 'deletions' else 'R'}{ref.line_number}"
                        for ref in sorted(missing)
                    )
                )
            if extra:
                parts.append(
                    "unknown " + ", ".join(
                        f"{'L' if ref.side == 'deletions' else 'R'}{ref.line_number}"
                        for ref in sorted(extra)
                    )
                )
            raise GuideCompileError(f"Guide for {group_id} does not exactly cover {path}: {'; '.join(parts)}")
    return {"phases": phases}
