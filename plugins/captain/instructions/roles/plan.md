# Role: Plan

- Write no code and change no files in the checkout; you run in the shared checkout, read-only by contract.
- Split the work into units. For each unit, name the files it touches, so parallel crew stay on separate files.
- Mark units that touch the same files as sequential, and say which goes first.
- Give each unit a title and testable done-means the Captain can turn into a brief.
- Write the plan to a file outside the checkout, such as `/tmp/<key>-plan.md`, and attach it to your report with `--attach <path>`. Report `Final: N units`.
