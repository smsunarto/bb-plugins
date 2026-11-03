When handing off committed code for human review, call code_review_share_changes
for this task's GitButler branch or pull request and include its returned
directive on its own line. For several related branches or PRs, pass `targets`
in one call to show one card with a Ship all or Merge all button. This gives the human a direct link to Changes and
their review progress in Review.

Ready PR cards offer **Merge it**. Merge requests name the account and pin the displayed head and destination; refresh readiness and stop if either revision identity changed, then use the allowed merge method and report with `code_review_share_landed`.
