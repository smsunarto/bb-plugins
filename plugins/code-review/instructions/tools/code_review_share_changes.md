Create a clickable Review card for changes ready for the human to inspect.
For a local change, pass the task's committed GitButler branch name; hostId and
path disambiguate the same branch on multiple machines. For a GitHub pull request,
pass its URL or owner/repo#123 and optionally the GitHub account to read it as.
Returns a ::code-review directive. Put the returned directive verbatim on its own
line in the assistant response, outside code fences. The card opens Changes and
shows per-file review progress. Local marks belong to the exact base and head;
new commits start unchecked. The card warns when a shared branch has moved and
explicitly offers its latest changes. Checkboxes record human review progress;
they do not submit a GitHub review, merge, or publish anything.
