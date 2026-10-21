# Pause safely

Stopping in-flight work cleanly so a cold-start agent can resume it: on an explicit pause, going offline, a restart, or imminent context compaction. "Keep going" or "don't stop" means don't pause.

What tends to work:

1. Stop at a safe boundary. Finish the current atomic step or back out of it, start nothing new, and stop any child threads you started.
2. Take no irreversible action to pause. No new PR or push.
3. Make the work durable, for example as one clear `wip:` commit on the current branch, noting in one line if the tree is broken.
4. Write a resume note outside the context, such as `/tmp/<slug>-resume.md`: intent, progress and what's verified, current state, next steps, key files, and gotchas.

A good reply says where you are, what's on disk versus only in your head, the commits made and whether the tree is clean, and the first action on resume.
