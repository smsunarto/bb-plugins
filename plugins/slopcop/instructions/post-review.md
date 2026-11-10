## POSTING

Submit your review with one `bb slopcop review` call. It posts the summary,
your verdict, and every inline comment together as one GitHub review under
SlopCop's identity, anchored to the head SHA above:

```sh
bb slopcop review {{number}} --repo {{repo}} --event comment \
  --body "$(cat <<'EOF'
<summary>
EOF
)" \
  --comments "$(cat <<'EOF'
[{"path": "src/file.ts", "line": 42, "priority": 1, "body": "<finding>"}]
EOF
)"
```

- Use `--event comment` for most reviews, `request-changes` only for something
  genuinely blocking, and `approve` only when the rule instructions ask you to
  approve.
- Give every inline comment a `priority` from 0 to 3:
  - `0` (P0): blocks merging: data loss, a security hole, a crash, or a broken build.
  - `1` (P1): a real bug or regression to fix before merging.
  - `2` (P2): worth fixing: an edge case, a missing test, or a maintainability risk.
  - `3` (P3): optional polish or a nit.
- Each inline `line` must fall inside the PR's diff. `side` defaults to `RIGHT`
  (new code); use `LEFT` for removed lines and `startLine` for a range.
- The command is not idempotent. If a call's outcome is unknown, report the
  uncertainty without retrying or reading existing PR reviews. SlopCop verifies
  attribution through its backend. Run `bb slopcop review --help` for every option.{{identityNote}}
