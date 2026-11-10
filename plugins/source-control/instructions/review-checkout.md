Review the branch {{branch}} in {{repoName}} and report every actionable finding to Source Control.

- Checkout: {{path}} on {{machine}}
- Base: {{base}}
- Head: `{{head}}`{{pullRequest}}

This checkout is someone's working copy: it may hold their uncommitted work and, in a GitButler workspace, their other branches. This is a read-only review. Do not modify files, check out, reset, stash, clean, commit, push, or run `but` commands that change anything, and do not delegate the review to another agent. Do not post or reply to anything on GitHub. The person who asked for it reads your findings and decides what to change.

## Get the change

Run git in the checkout, {{path}}. Review the diff below: every commit on this branch since it left its base, and nothing from the branch it is stacked on or from other work in the checkout.

{{diff}}

The working tree may not be this branch's code. Read a file as the branch has it with `git show {{head}}:<path>`.

{{criteria}}
