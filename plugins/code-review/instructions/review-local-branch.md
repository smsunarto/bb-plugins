Review the unpublished branch {{branch}} in {{repoName}} and report every actionable finding to the Code Review panel.

- Checkout: {{path}} on {{machine}}
- Base: `{{base}}`{{parent}}
- Head: `{{head}}`

Commits, newest first:

{{commits}}

The branch has no pull request yet. It lives in a GitButler workspace, which holds the reviewer's other branches and uncommitted work in the same working tree.

This is a read-only review. Do not modify files, check out, reset, stash, clean, commit, or run `but` commands that change anything, and do not delegate the review to another agent. The person who asked for it reads your findings and decides what to change.

## Get the change

Run git in the checkout, {{path}}. Review `git diff {{base}} {{head}}`: every commit on this branch, and nothing from the branch it is stacked on or from the other branches in the workspace.

The working tree mixes every applied branch, so it is not this branch's code. Read a file as the branch has it with `git show {{head}}:<path>`.

{{criteria}}
