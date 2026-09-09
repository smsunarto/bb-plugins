---
name: index-projects
description: Index every repository in ~/git for Kitchen Sink autorouting, with a one-line summary and three distinct example tasks per repository. Run only when the user invokes /index-projects.
disable-model-invocation: true
---

Build or refresh Kitchen Sink's autorouter project index for the current host.

1. Identify the invoking BB host with `bb status --json` and the current thread's environment. Use `bb project list --json` and `bb project --help` to inspect existing projects and their source paths. Match a repository to a project by its registered source path and host, or by its Git remote when the mapping is unambiguous. Do not guess a project ID from a similar display name.
2. Read the current index with `bb kitchen-sink rpc getAutorouterProjectIndex`. Preserve entries belonging to other hosts. Preserve useful manual corrections on this host unless source evidence contradicts them.
3. Enumerate repositories beneath `~/git` on this host, including nested repositories and Git worktrees (`.git` can be a file). Prune `.git`, dependency caches, build output, and vendor directories. Do not mistake a monorepo package without its own `.git` for a separate repository. Report directories you cannot inspect instead of silently treating the scan as complete.
4. Inspect each repository's README, AGENTS.md, package/module manifest, and a small sample of relevant source directories. Read enough to distinguish its responsibility from neighboring repositories. Use source evidence rather than the folder name alone. Do not read credentials, environment secrets, or generated dependency contents.
5. Write one entry for every discovered repository using this schema:

   ```json
   {
     "repository": "bb-plugins",
     "path": "/absolute/path/to/git/bb-plugins",
     "hostId": "host-id-from-bb",
     "projectId": "project-id-from-bb-or-null",
     "summary": "BB plugins for personal UI, agent workflows, and integrations.",
     "examples": [
       "Add a composer action to the Kitchen Sink plugin.",
       "Fix the GTD sidebar's project filter.",
       "Update the Monokai plugin's theme colors."
     ]
   }
   ```

   Use JSON `null`, not the string `"null"`, for `projectId` when no existing BB project matches. Keep those repositories in the index. Do not create projects as part of indexing. Use an absolute path and the actual host ID. The summary must be one line. Supply exactly three nonempty, distinct, single-line task prompts covering different responsibilities or workflows in that repository. Avoid generic examples such as "fix a bug" that could fit any repository.

6. Save the merged index through the plugin's validated RPC. Write a JSON object with an `entries` array to a temporary file, then invoke the command with an argument array so JSON is never interpreted as shell code. For example:

   ```python
   import pathlib, subprocess
   payload = pathlib.Path("/tmp/autorouter-index.json").read_text()
   subprocess.run(
       ["bb", "kitchen-sink", "rpc", "saveAutorouterProjectIndex", payload],
       check=True,
   )
   ```

   The file contains `{"entries": [ ... ]}`. Read the index back with `getAutorouterProjectIndex` and check the repository count, host/path uniqueness, project mappings, and three examples per entry. If the scan was incomplete, merge updates into existing entries instead of deleting entries that were not observed.

7. Report how many repositories were indexed, which have no BB project, and any inspection failures. Tell the user that summaries and example prompts can be edited in Kitchen Sink's **Autorouter project index** setting.
