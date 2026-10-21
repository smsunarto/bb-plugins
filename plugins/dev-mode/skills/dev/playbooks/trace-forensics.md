# Trace forensics

Diagnose a capture that already exists: a cpuprofile, trace, spindump, or heap snapshot. Unlike [Runtime forensics](runtime-forensics.md), the artifact is a fixed dataset to read, not something to re-run.

What tends to work:

1. Identify the format and load it with a matching tool: a DevTools or trace parser for cpuprofile and `.json.gz`, a text editor for a spindump, heap tooling for a snapshot. A subagent can parse a large artifact and return only the reduced finding.
2. Turn it into something you can query before reading it, such as a sqlite table with one row per sample, frame, or node.
3. Narrow to the cause. Find the frames holding the most time and walk the call tree to the hot path. For a leak, follow the retainer chain to a GC root. For a spindump, find the thread stuck on-CPU or blocked, and its wait reason.
4. Attribute it to source through the artifact's own symbols. A frame without a source mapping isn't a diagnosis yet; resolve the symbols or say the artifact lacks them.
5. With a paired capture, diff before and after to confirm. Without one, present the finding as the strongest hypothesis the artifact supports.

A good reply covers the artifact and format, the reduced finding, the source location, the artifact paths, and whether a paired capture confirmed it.
