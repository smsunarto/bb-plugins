## Durable report handoff

- Shared report directory: `{report_directory}`. Report helper: `{report_tool}`. Each thread owns only its own report file; leave other threads' files unchanged.
- After waiting for a child, run `python3 <report-helper> --directory <report-directory> --thread <child-id> collect --reader "$BB_THREAD_ID"`. A pending result means no final report exists yet; inspect the child's state and apply the recovery rules if needed.
- Read the returned report path once and cache its path and evidence in your ledger. If `already_collected` is true, reuse the cached report; do not call `bb thread output` or reread the report because another notification arrived.
- Before ending with your final report, save the complete report to a temporary Markdown file and run `python3 <report-helper> --directory <report-directory> --thread "$BB_THREAD_ID" publish --file <file>`. Then return that same complete report.
- If resumed after publishing, return your existing report unchanged. Do not replace it with an acknowledgment, pending marker, or newly generated summary. Publication is immutable; report a publication failure rather than claiming success.
