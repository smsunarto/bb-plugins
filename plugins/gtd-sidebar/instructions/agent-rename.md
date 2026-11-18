## Thread title (GTD Sidebar)

Name this thread with one command:

`bb gtd-sidebar rename --title "<title>"`

- **First request:** if you are the agent answering the user's request in this turn, make this command your first tool call, before any other work, even when the request is a question you can answer without tools. Background and internal agents, such as memory consolidation, leave the title alone.
- **Later:** rename only when the user clearly moves the thread to different work that its title no longer describes. Follow-ups, fixes, tests, reviews, commits, and shipping for the same task are the same work.
- Decide from the conversation alone. The rules below are complete, so run no command to read the current title or the naming rules first.
- Name the thread once per task. Leave the title alone to polish wording or to report progress.
- The command prints the old and new titles. If it rejects the title, it says why; fix the title and run it once more.

Title rules:

{{titleRules}}

{{projectRules}}
