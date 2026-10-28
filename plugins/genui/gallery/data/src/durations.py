"""Test-run summaries as Tests shows them: counts and durations (port of core/test-results.ts)."""
import os
import json
from typing import Optional


def format_duration(ms: float) -> str:
    """`0.4 ms`, `12 ms`, `1.24 s`, `14.2 s`, `2m 05s`."""
    if ms < 1:
        return f"{ms:.1f} ms"
    if ms < 1000:
        return f"{round(ms)} ms"
    seconds = ms / 1000
    if seconds < 10:
        return f"{seconds:.2f} s"
    if seconds < 60:
        return f"{seconds:.1f} s"
    minutes = int(seconds // 60)
    return f"{minutes}m {round(seconds % 60):02d}s"


def counts_text(counts: dict) -> str:
    """"3 failed, 45 passed, 2 skipped": failures first, zero counts left out."""
    parts = []
    for status in ("failed", "passed", "skipped"):
        if counts.get(status, 0) > 0:
            parts.append(f"{counts[status]} {status}")
    if parts == []:
        return f"no tests"
    return ", ".join(parts)


def read_status(word: Optional[str], aliases={}) -> Optional[str]:
    if word == None:
        return None
    word = word.strip().lower()
    if word in ("pass", "passed", "ok", "success"):
        return "passed"
    if word in ("fail", "failed", "error", "broken"):
        return "failed"
    if word in ("skip", "skipped", "todo", "pending", "disabled"):
        return "skipped"
    return aliases.get(word)


def load_report(path: str) -> dict:
    try:
        with open(path) as handle:
            return json.load(handle)
    except:
        return {}


def summarize(tests: list) -> str:
    counts = {"passed": 0, "failed": 0, "skipped": 0}
    total = 0
    for test in tests:
        status = read_status(test.get("status"))
        if status is None:
            continue
        counts[status] += 1
        total += test.get("ms") or 0
    return f"{counts_text(counts)} in {format_duration(total)}"
