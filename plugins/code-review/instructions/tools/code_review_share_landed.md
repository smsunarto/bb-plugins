Show the human a Landed card once this thread's work has merged or reached the default branch. The card lists what landed and has a **Settle thread** button that archives the thread. The tool also puts 🚀 in front of the thread title while everything the thread delivered has landed. Use `code_review_share_changes` instead to hand off work that still needs review.

USE WHEN

- You merged one of this thread's pull requests, or a pull request watch reported that it merged.
- You pushed this thread's commits to the repository's default branch without a pull request.

INPUTS

- A single card can include work from multiple repositories: pass all their references in one call, up to 25 pull requests and 25 commits.
- `pullRequests`: URLs or `owner/repo#123` for every pull request this thread delivered, including ones that merged earlier and ones still open. Leave out a pull request closed without merging that another one replaced: it can never land, so it would keep the 🚀 off.
- `commits`: `owner/repo@<sha>` or GitHub commit URLs for work pushed straight to the default branch. List the newest commit of each push; it covers the commits before it.
- `account`: the GitHub login to read them as, when `gh` is signed in to several accounts. Defaults to gh's active account.

List all of the thread's work, not only what just landed: the 🚀 depends on the complete list.

RETURNS AND NEXT STEP
The first line is a `::code-review-landed` directive. Put it verbatim on its own line in your response, outside code fences. The rest of the result says whether everything has landed, or names what has not. Report what remains open. Until it lands, the server rechecks every few minutes and adds the 🚀 itself, even after your turn ends, and the card updates too.

SIDE EFFECTS AND RECOVERY
GitHub is the source of truth: a pull request counts once it merged, and a commit once the default branch on GitHub contains it, so push before calling. The call fails when nothing listed has landed yet. It stops this thread's watches of the merged pull requests, since their merge is already handled. The call fails while this thread watches a pull request it does not list: list it, or stop the watch if it is not this thread's work. A call with work still open removes an earlier 🚀. Settling is the human's choice; do not archive the thread yourself.
