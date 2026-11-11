Write a reading guide for the change {{change}} in {{repoName}}, so a reviewer reads its files in the order that makes it easiest to understand. Report it with `source_control_write_guide`. This is read-only: do not modify files, check out, reset, stash, commit, push, run `but` commands that change anything, or post to GitHub.

{{where}}

The diff command above is complete: it already names the base and the head. Run it, or its `--stat` form, and read from there; you do not need to find the default branch, the remote or the base.

## The files

These are every file in the change, with what changed in each. The guide may name only these paths, or a directory of them ending in `/`.

{{files}}

## Reading economically

- Read what you need to order and describe the files, not every line. Start from `--stat`, then read the files that carry the change.
- When many files share one shape (generated, repeated or copied files), read one or two in full and confirm the rest match with a hash, `--stat` or a `grep` over the diff instead of reading each.
- Combine reads into one command. One to three commands are usually enough before you write the guide.

## The guide

- Put the files in 2 to 8 groups, in the order to read them: the core of the change first, then what calls or depends on it, then tests, then generated files and lockfiles last.
- Title each group in a few words. Give each an intro of one to three sentences: what the group does and what to look at first.
- Give a file a one-line note when it tells the reader something its path does not, such as "Registers the client on the host contract". Leave the note out otherwise.
- Write a summary of two or three sentences: how many groups, where the risk is, and what can be skimmed.
- Place every file once. Name a whole directory with a trailing `/` when all its files belong together; a file you name on its own elsewhere stays there. Small changes may need only one or two groups.
- Plain, short sentences. No headings or lists inside intros, notes or the summary.

Call `source_control_write_guide` once with the whole guide. If it refuses a path, fix the guide and call it again; the latest call replaces the earlier one. Then stop, with one short line saying it is saved.
