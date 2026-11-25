---
name: captain-brief
description: Write the brief for a crew thread, the description of the task the Captain dispatches. Use before every bb captain create that starts crew work.
---

# Captain brief

A brief is the task's description. Every role dispatched on the task reads the same brief: Implement builds against it, and Review checks the change against it. It holds only what this task needs: the change, done means, scope, and what the threads can rely on. The role contracts and `CREW.md` already carry the standing rules.

## Write it

1. Copy the template below into `briefs/<slug>.md` in your Drive, the path your Captain rules name.
   - **If you need the target branch or the checkout:** `bb tasks project show <KEY>` names the repo's bb project, and `bb project show <id>` its checkout path. Without a branch from the user, the target is the repo's default branch.
2. Fill every section, including the `Target branch:` and `Remote:` lines. Use `direct ship` when the repo is on `captain-ship`'s direct-ship list; `yes` keeps such a repo on the PR path. `captain-ship` classifies the repo again at ship time. Each done-means item must be something you can check yourself from the commits, tests, PR, pushed branch or a run.
3. Create the task: `bb captain create --project <KEY> --title "<title>" --description-file <Drive>/briefs/<slug>.md`. It prints the new key and lists the task on your Overview.
4. Dispatch it: `bb captain dispatch <key> --role Implement`. Implement plans its own work before it builds.
   - **If the task is research or design only:** still dispatch Implement, and say "no code" in the brief. Implement then attaches its result to its `Final:` report, with no commit, push or PR. Write done-means you can check from that attachment. When the report arrives, check the attachment, set the task `done` with `bb tasks update <key> --status done`, and archive the crew thread with `bb thread archive <id>`. Record no review verdict and open no ship ask.

The brief is done when every section is filled and each done-means item names a check.

```text
You are a crew thread for the <name> Captain.

<The change in one or two sentences.>

## Done means
<Testable outcomes, numbered, each with the check that shows it. The Captain and Review check against these.>

## Out of scope
<Where this thread's ownership ends: files, features, repos it must not touch.>

## What you can rely on
Target branch: <branch, such as main>. Review diffs against it.
Remote: <yes: push the branch and open a draft PR | direct ship: push the branch; no PR | none: commit on your branch only>.
<The test instance, and what other threads are touching.>

## Rules
<What comes back to the Captain and what the thread decides alone. CREW.md applies.>

## Report
<What the final comment holds beyond the role's contract, and which files to attach.>
```

## Leave out

- The role's contract: dispatch delivers it. Do not restate how to report, commit or review.
- Rules already in `CREW.md` or `repos/<KEY>.md`.
- Your own guesses at the cause or the fix, unless you checked them. Mark anything unchecked as a hypothesis.
- Secrets and credentials. The thread requests them with `bb secret request`.

## Steer Review

- Add a `Lenses:` line to the brief to add or drop lenses, such as `Lenses: +visual -performance`, or to name a Drive lens.
- Without it, the Review thread picks lenses from the diff.
- Drop lenses that cannot apply to the diff, such as `-visual` for a server-only diff.
- The implementer's report stays out of the brief: post nothing from it into the description, so the lenses stay blind.
