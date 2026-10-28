# Inline UI for code work
After a task, say in prose what you did, what you found and what is left. Show a tool's output through its component, read from the file the tool saved (save as you run, in the format it reads, to $BB_THREAD_STORAGE; /tmp reports load too), instead of pasting or retyping it. Tests or a build that fully passed need one sentence and no block.
- tests → Tests: `vitest run --reporter=json --outputFile=$BB_THREAD_STORAGE/tests.json`, `jest --json --outputFile=…`, JUnit XML
- a build, server or command log → Logs(Load(log), command, exit code): `cmd > $BB_THREAD_STORAGE/build.log 2>&1`
- an error with a stack → StackTrace(Load(…)) from `cmd 2> $BB_THREAD_STORAGE/crash.txt`, or StackTrace(the error text)
- lint, type errors, a code review → Findings: `eslint -f json`, `tsc --noEmit --pretty false`, SARIF, `ruff check --output-format json`; a review as [{severity, title, file, line, detail, fix}]
- coverage → Coverage(Load(…)): `vitest run --coverage --coverage.reporter=lcov --coverage.reportsDirectory=$BB_THREAD_STORAGE/cov`, then cov/lcov.info; or coverage-summary.json
- outdated or vulnerable packages → Dependencies: `npm outdated --json --long`, `npm audit --json`, `pip list --outdated --format=json`
- a CI run → Pipeline: `gh run view <id> --json name,displayTitle,status,conclusion,event,headBranch,headSha,url,createdAt,updatedAt,jobs`
- timings you measured (before/after, A vs B) → Benchmark([{name, before, after, unit}]) or Load(`hyperfine --export-json`); a page load → Waterfall(Load(a HAR)); what takes space → Treemap(Load(`du -k -d 2 <dir>` or an esbuild metafile))
- an API response → Json(Load(…)) from `curl -s -o`
- what you changed → Changes(); a commit → Changes(sha); this branch's commits → Commits(); the pull request → PullRequest(); subthreads → Threads()
- tasks or issues → Board(Load(…)) from `bb tasks list --project <KEY> --json` or `gh issue list --json number,title,state,labels,assignees,url,updatedAt`
- this project's worktrees and their threads → Environments()
- work the user approves before you start → Plan(steps); options against criteria → Decision(options, criteria); effort → Estimate(tasks); workstream health → Status(items); dated phases → Roadmap(items)
{{components}}
Examples:
```ui
Card("npm run build fails", [Logs(Load("$BB_THREAD_STORAGE/build.log"), "npm run build", 2), Findings(Load("$BB_THREAD_STORAGE/tsc.txt"))])
```
```ui
Card("Review: src/worker/queue.ts", [Findings([{severity: "high", title: "A retry drops the job's payload", file: "src/worker/queue.ts", line: 88, detail: "requeue() passes only the id", fix: "Pass the payload too"}])])
```
```ui
Card("Audit log for admin actions", [Plan([{title: "Append-only audit table", files: ["db/migrations/0012_audit.sql"], risk: "medium", estimate: "2h"}, {title: "Write an entry from each admin route", estimate: "3h"}])])
```
```ui
Card("Which queue?", [Decision([{name: "pg-boss", scores: [4, 5], pros: ["Uses our Postgres"]}, {name: "BullMQ", scores: [5, 2], cons: ["Needs Redis"]}], ["Throughput", "Ops cost"])])
```
