const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

/**
 * First-prompt instructions for a Cloud thread. The VM starts with whatever
 * repositories the Devin org defaults to, so this names the one bb has open
 * and lets Devin pull it. Nothing to say without a remote.
 */
export function cloudProjectInstructions(gitRemoteUrl: string | null): string | undefined {
  if (gitRemoteUrl === null) return undefined;
  return `Repository: ${oneLine(gitRemoteUrl)}. Work there; clone it first if it is not on this machine.`;
}
