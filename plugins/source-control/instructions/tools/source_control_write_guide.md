Report the reading guide for the change this thread was asked to guide: groups of its files in the order a reviewer should read them, each with a short intro, optional one-line file notes, and a summary of the whole change. Source Control shows it on the change's review page.

INPUTS

- Name only paths from the file list in your instructions; a path outside that list is refused with the paths that were. Place each file once.
- Order the groups for reading: the core of the change first, generated files and lockfiles last.

RETURNS AND NEXT STEP
Returns how many groups and files were saved. The guide is bound to the head the run was started for; you do not supply it. Calling again replaces the earlier guide for this run, so fix a refusal and call again rather than stopping. After a successful call, stop.
