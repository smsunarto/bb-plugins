Watch a GitHub pull request this thread owns, so bb wakes the thread when it needs you. Read the `babysit-pr` skill before babysitting a pull request.

USE WHEN

- You opened or are working on a pull request and need to follow its CI and review until it is ready, merged, or blocked.
- Only the thread that owns the pull request watches it. A reviewer or other delegated child thread leaves watching to its parent.

BEFORE CALLING
Handle the checks and comments that already exist. The watch reports only what changes after the call.

INPUTS

- `reference`: the pull request's URL or `owner/repo#123`.
- `account`: the GitHub login to read it as, when `gh` is signed in to several accounts. Defaults to the first signed-in account that can see the repository, on the bb server or this thread's host.
- `stop: true` stops this thread's watch of `reference`.

RETURNS AND NEXT STEP
Returns the head commit, its check summary, and the merge state. End your turn after it. The thread then gets a message when a check fails, all checks finish on the head (again after a re-run), someone else comments or reviews, the branch conflicts with or falls behind its base, or the pull request merges or closes. News that arrives while you work waits until your turn ends and arrives as one message. A wake is news, not a merge decision: check the merge gate yourself. When a wake needs no action, end your turn without a message.

SIDE EFFECTS AND RECOVERY
Starting a watch takes a 🚀 off the thread title, since the thread has open work again. A pull request the thread has not listed with `source_control_share_landed` ends that tool's background check; call `source_control_share_landed` once it merges. The watch is stored on the bb server: it persists across your turns, pushes and server restarts, and a push starts the new head's checks over, so you do not need to watch again. Watching the same pull request again keeps the existing watch. A merge or close ends the watch on its own; otherwise call with `stop: true` before you hand off, so later news does not wake the thread after the human takes over. Each thread watches at most five pull requests, and a pull request another live thread watches is refused. While the account's site is away (its host asleep, `gh` signed out there) or GitHub's rate limit runs low, the watch waits and reads again later. GitHub not finding the pull request, or ten failed reads in a row, stop the watch with a message that says why.
