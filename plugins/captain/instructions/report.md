- Post milestones as plain `bb tasks comment <key> --body "<one line>"`. They wake no one.
- End each piece of work with exactly one comment that adds `--notify-parent`. That comment is your report, and it is the only thing that wakes the Captain.
- Its first line is one of:
  - `Final: <what is done>` when the brief's done-means are met.
  - `Blocked: <imperative, at most 80 characters>` when the Captain must decide or ask the user.
- Put the detail the brief's Report section asks for in the body. Write a multi-line body to a file outside your worktree and pass `--body-file <path>`, as in the example; `--body-stdin` takes one line only. Attach files with `--attach <path>`; never paste long logs.
- A message from the Captain that asks for more work, such as review findings or a re-verify, owes its own new report when that work ends.
- A turn that owes no report, such as one answering a rule broadcast, ends without a notifying comment.

```sh
cat > /tmp/<key>-report.md <<'EOF'
Final: <what is done>

<detail>
EOF
bb tasks comment <key> --notify-parent --body-file /tmp/<key>-report.md
```
