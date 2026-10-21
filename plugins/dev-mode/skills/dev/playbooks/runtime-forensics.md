# Runtime forensics

Diagnose a live symptom from instrumentation instead of theorizing from source. The deliverable is a cited diagnosis, not a fix.

What tends to work:

1. Capture the live signal on the matching surface: a CPU profile for a spinning process, a heap snapshot for a leak, a CDP trace for a visual glitch.
2. Reduce the artifact to the smoking gun: the function on the hot path, the retainer chain from the leaked object to a GC root, the loop firing without input. A subagent can parse a large artifact and return only the reduced finding.
3. Confirm the mechanism cheaply before believing it, for example by injecting instrumentation into the running process with CDP eval.
4. Map the finding back to source: the file, symbol, and line that allocates or schedules.

Once the cause is known, a fix usually moves to [Bug fix](bug-fix.md) or [Perf issue](perf-issue.md).

A good reply covers the signal captured, the reduced finding, how you confirmed the mechanism, the source location, and the artifact paths.
