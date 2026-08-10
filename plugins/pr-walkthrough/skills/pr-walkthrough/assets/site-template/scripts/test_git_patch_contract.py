#!/usr/bin/env python3
"""Focused regression tests for Git path and patch byte preservation."""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from compile_walkthrough import parse_patch
from guide_contract import LineRef, decode_git_path, index_patch, synthesize_patch


class GitPatchContractTests(unittest.TestCase):
    def test_unquoted_modified_path_with_spaces_matches_in_both_indexes(self) -> None:
        path = "src/file with spaces.txt"
        patch = (
            f"diff --git a/{path} b/{path}\n"
            "index 3367afd..3e75765 100644\n"
            f"--- a/{path}\t\n+++ b/{path}\t\n"
            "@@ -1 +1 @@\n-old\n+new\n"
        )
        self.assertEqual(parse_patch(patch, "")[0]["path"], path)
        self.assertEqual(index_patch(patch)[path].path, path)

    def test_c_quoted_utf8_and_escapes_match_in_both_indexes(self) -> None:
        path = 'src/café\t"quoted".txt'
        patch = (
            'diff --git "a/src/caf\\303\\251\\t\\"quoted\\".txt" '
            '"b/src/caf\\303\\251\\t\\"quoted\\".txt"\n'
            '--- "a/src/caf\\303\\251\\t\\"quoted\\".txt"\n'
            '+++ "b/src/caf\\303\\251\\t\\"quoted\\".txt"\n'
            '@@ -1 +1 @@\n-old\n+new\n'
        )
        self.assertEqual(parse_patch(patch, "")[0]["path"], path)
        self.assertEqual(index_patch(patch)[path].path, path)

    def test_rename_and_copy_metadata_preserve_spaces_and_decode_quotes(self) -> None:
        rename = (
            'diff --git a/old.txt b/placeholder.txt\n'
            'similarity index 100%\nrename from old name.txt\n'
            'rename to "new caf\\303\\251\\t\\"name\\".txt"\n'
        )
        renamed_path = 'new café\t"name".txt'
        compiled = parse_patch(rename, "")[0]
        self.assertEqual((compiled["previousPath"], compiled["path"]), ("old name.txt", renamed_path))
        self.assertIn(renamed_path, index_patch(rename))

        copy = (
            'diff --git a/source name.txt b/copied name.txt\n'
            'similarity index 100%\ncopy from source name.txt\ncopy to copied name.txt\n'
        )
        copied = parse_patch(copy, "")[0]
        self.assertEqual((copied["previousPath"], copied["path"]), ("source name.txt", "copied name.txt"))
        self.assertIn("copied name.txt", index_patch(copy))

    def test_all_git_letter_escapes_decode(self) -> None:
        self.assertEqual(
            decode_git_path('"a\\ab\\bc\\td\\ne\\vf\\fg\\rh"'),
            "a\x07b\x08c\td\ne\x0bf\x0cg\rh",
        )

    def test_hunk_content_that_looks_like_file_markers_remains_content(self) -> None:
        patch = (
            "diff --git a/file.txt b/file.txt\n"
            "--- a/file.txt\n+++ b/file.txt\n"
            "@@ -1 +1 @@\n--- old option\n+++ new option\n"
        )
        compiled = parse_patch(patch, "")[0]
        indexed = index_patch(patch)["file.txt"]
        self.assertEqual((compiled["path"], compiled["deletions"], compiled["additions"]), ("file.txt", 1, 1))
        self.assertEqual(indexed.changed_refs, frozenset({LineRef("deletions", 1), LineRef("additions", 1)}))

    def test_original_and_synthesized_patches_preserve_trailing_whitespace(self) -> None:
        patch = (
            'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n'
            '@@ -1,2 +1,2 @@\n-old  \r\n+new\t\r\n context \t\r\n'
            '\\ No newline at end of file\n'
        )
        compiled_patch = parse_patch(patch, "")[0]["patch"]
        indexed = index_patch(patch)["file.txt"]
        self.assertEqual(compiled_patch.encode(), patch.encode())
        self.assertEqual(indexed.original_patch.encode(), patch.encode())

        synthesized, _visible = synthesize_patch(
            indexed, (LineRef("deletions", 1), LineRef("additions", 1)), 1
        )
        self.assertIn(b"-old  \r\n", synthesized.encode())
        self.assertIn(b"+new\t\r\n", synthesized.encode())
        self.assertIn(b" context \t\r\n", synthesized.encode())
        self.assertTrue(synthesized.endswith("\\ No newline at end of file\n"))

    def test_malformed_quoted_path_is_stable_and_does_not_crash(self) -> None:
        patch = 'diff --git a/file.txt b/file.txt\nrename to "bad\\q.txt"\n'
        self.assertEqual(parse_patch(patch, "")[0]["path"], '"bad\\q.txt"')
        self.assertIn('"bad\\q.txt"', index_patch(patch))


if __name__ == "__main__":
    unittest.main()
