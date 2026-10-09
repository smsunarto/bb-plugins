# Code Review

## Sub-features

- **Code Review** sidebar entry, with a badge counting pull requests that wait on the viewer's review.
- Inbox sections: **Assigned to me**, **My team**, **Authored by me**, and **Pinned**.
- A pull request's **Summary**, **Changes**, and **Checks** tabs.
- Draft comments on a diff line, held in the viewer's pending GitHub review, and **Submit review**.
- **Review with Codex**, which starts a Codex thread whose findings return to Summary and Changes.
- **Fix** on a failing check, which opens a prefilled new-thread composer.
- A `gh` status notice when GitHub CLI is missing or signed out.

## How to get to it (user POV)

Select **Code Review** in the sidebar. The inbox lists open pull requests in its sections and must leave loading. Select a pull request. Its Summary opens on the right with the title, `#number`, state, and `head → base`.

The page subPath is `owner/repo/pull/<n>`, plus `/changes` or `/checks` for those tabs. Paste one to open a pull request directly.

## Driving it with agent-browser

Labels come from this plugin's app. Take a snapshot first and use the names it shows.

```bash
agent-browser --session "$BROWSER_SESSION" snapshot
agent-browser --session "$BROWSER_SESSION" find text "Code Review" click
agent-browser --session "$BROWSER_SESSION" wait --text "Assigned to me"
agent-browser --session "$BROWSER_SESSION" snapshot
```

Prove one terminal state for each path you changed:

- Inbox: at least one section lists a pull request, or every section shows its empty state. A signed-out `gh` shows the status notice instead.
- Summary: the description and reviewers render, and **View all** under checks opens the Checks tab.
- Changes: each changed file renders a diff. Existing review threads sit on their lines.
- Checks: failures sort first. **Fix** opens a composer whose prompt names the failing checks.
- Review with Codex: a linked thread appears under the pull request's threads. Once it reports, findings appear on Summary and inline on Changes.

Read paths can use any pull request `gh` can see, such as `cli/cli/pull/9000`.

## Gotchas

- The plugin calls `gh` on the bb server's machine. Run `gh auth status` there before you report an empty inbox as a product gap.
- A draft comment is a real write: it starts a pending review on GitHub. Viewed marks and **Submit review** write too. Prove write paths only on a pull request in a sandbox repository you own, then discard the drafts.
- **Review with Codex** and **Fix** need the repository as a bb project whose git remote is the GitHub repository. Without one, Review with Codex reports `Add <owner>/<repo> as a bb project to review it with Codex.`
- A Codex review is a real agent run on the pinned instance. Wait for the thread to go idle before you look for findings.
- The server tests replay recorded GitHub responses. They do not prove the UI rendered. Capture the panel.
