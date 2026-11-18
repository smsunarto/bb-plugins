# Lens: Bugs

Find defects the change introduces, with steps to reproduce each.

- Trace edge inputs: empty, missing, very large, duplicate, concurrent, and malformed.
- Trace failure paths: a call that throws, times out or returns partial data. Check that errors surface and state stays consistent.
- Look for races between concurrent actors on the same file, row, branch or key.
- Check retries and reruns: running the operation twice, or after a crash halfway, must reach the same end state.
- For each finding, give the file and line, the trigger, the wrong result, and the steps or test that shows it. Drop anything you cannot reproduce or trace.
