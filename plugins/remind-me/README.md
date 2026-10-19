# Remind Me

Type `/remind-me` in a conversation to save unfinished work for later. Add an optional hint to choose the subject; otherwise, the agent infers it from the recent conversation and stops after saving.

Reminders live in the plugin’s own persistent database, separately from BB Tasks and your repository. Open **Reminders** from the navigation rail or a conversation’s panel launcher. Expand a reminder to read its context, next step, and source thread.

Hover over a reminder (or focus it with the keyboard) and choose **Add to composer**. On touch screens the button stays visible. The Reminders page appends to the new-thread draft and opens it; a conversation panel or reminder card appends to that conversation’s draft. Existing text and attachments are preserved. Nothing is sent, started, or removed automatically.

The agent workflow is in `instructions/remind-me.md`, exposed through `bb remind-me prompt`. `bb remind-me rpc list`, `save`, and `get` read and write the same store. Saves use a caller-generated UUID: retrying the same ID and payload returns the existing reminder; different content with that ID is rejected. Reminders survive plugin reloads. This plugin does not schedule notification alerts or migrate previously created BB tasks.
