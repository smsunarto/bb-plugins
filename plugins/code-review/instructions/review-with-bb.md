Review pull request {{owner}}/{{repo}}#{{number}} and report every actionable finding to the Review panel.

- Title: {{title}}
- URL: {{url}}
- Base: {{baseBranch}} at `{{baseRefOid}}`
- Head: {{branch}} at `{{headRefOid}}`

This is a read-only review. Do not modify files, create commits, push branches, post or reply to comments on GitHub, approve, or request changes, and do not delegate the review to another agent. The person who asked for it reads your findings and decides what to post.

## Get the change

Fetch the pull request's head and base, then find the commit the change branches from. Run these from the repository, exactly as quoted:

{{fetch}}

If the remote is not named `origin`, use the remote that points at github.com/{{owner}}/{{repo}}.

{{workspace}}

Review `git diff <merge-base> {{headRefOid}}`: what would merge, not a diff against the tip of the base branch.

{{criteria}}
