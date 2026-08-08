export type StackAction = "sync" | "submit";

export function isCurrentBranchNotInStack(code: number, stderr: string): boolean {
  if (code !== 2) return false;
  return /current branch\s+"[^"]+"\s+is not part of a stack/i.test(stderr);
}

function hasExactSyncAbortedOutput(...outputs: string[]): boolean {
  return outputs
    .flatMap((output) => output.split(/\r?\n/))
    .some((line) => /^sync aborted(?:\s*[—-]\s*no changes were made)?[.!]?$/i.test(line.trim()));
}

// Positive allowlist for Sync states that need repository-aware recovery.
// Infrastructure, authentication, timeout, push, and generic CLI failures
// remain ordinary errors instead of starting an agent turn.
export function requiresAgentSyncRecovery(
  code: number,
  ...outputs: string[]
): boolean {
  if (code === 3 || code === 7) return true;
  const text = outputs.join("\n");
  return (
    hasExactSyncAbortedOutput(text) ||
    /your local stack has diverged from the stack on github/i.test(text) ||
    /PR .* has base .*expected .*but cannot update while stacked/i.test(text) ||
    /your PRs belong to multiple stacks on GitHub/i.test(text) ||
    /the stack on GitHub differs from your local stack and couldn['’]t be updated automatically/i.test(
      text,
    ) ||
    /(?:cannot|could not) create stack:\s*invalid PR chain/i.test(text)
  );
}

// gh-stack intentionally treats several push, pull-request, and remote-stack
// failures as best effort. Convert those exit-0 outputs into honest failures
// for the plugin; callers still perform Git/PR postcondition checks afterward.
export function partialSuccessWarning(
  action: StackAction,
  stdout: string,
  stderr: string,
): string | null {
  const output = `${stdout}\n${stderr}`;
  if (action === "sync" && hasExactSyncAbortedOutput(output)) {
    return "Local and remote stacks diverged; sync aborted with no changes.";
  }
  if (action === "sync" && /push failed/i.test(output)) {
    return "Sync changed local state, but one or more branches were not pushed.";
  }
  if (
    action === "sync" &&
    /could not resolve branch SHAs\s+—?\s*skipping rebase/i.test(output)
  ) {
    return "Sync skipped a required rebase because branch SHAs could not be resolved.";
  }
  if (
    action === "submit" &&
    /failed to (?:check PR for|create PR for|update base branch for PR|mark PR .* as ready for review)/i.test(
      output,
    )
  ) {
    return "Submit completed only partially; one or more pull-request operations failed.";
  }
  if (/PR .* has base .*expected .*but cannot update while stacked/i.test(output)) {
    return `${action === "sync" ? "Sync" : "Submit"} left one or more pull requests on the wrong base branch.`;
  }
  if (/failed to disable auto-merge for PR/i.test(output)) {
    return `${action === "sync" ? "Sync" : "Submit"} could not disable auto-merge for one or more pull requests.`;
  }
  if (/your PRs belong to multiple stacks on GitHub/i.test(output)) {
    return `${action === "sync" ? "Sync" : "Submit"} could not reconcile pull requests that belong to multiple GitHub stacks.`;
  }
  if (
    /the stack on GitHub differs from your local stack and couldn['’]t be updated automatically/i.test(
      output,
    )
  ) {
    return `${action === "sync" ? "Sync" : "Submit"} could not reconcile the local and GitHub stack definitions.`;
  }
  if (
    /(?:failed to (?:read|update|create) stack on GitHub|cannot create stack:|could not create stack:|stacked PRs are not enabled)/i.test(
      output,
    )
  ) {
    return `${action === "sync" ? "Sync" : "Submit"} could not update the stacked pull request on GitHub.`;
  }
  return null;
}
