// The New Captain form's rules, kept pure so they test without a DOM. Captain
// checks the same rules again and has the last word; these only catch what the
// form can see before a round trip.
import { CAPTAIN_NAME_MAX } from "./captain-contract";

export interface RepoChoice {
  id: string;
  name: string;
}

export interface NewCaptainProblems {
  name: string | null;
  repos: string | null;
}

/** What blocks a submit, per field; both null when the form may be sent. */
export function newCaptainProblems(name: string, repos: readonly string[]): NewCaptainProblems {
  const trimmed = name.trim();
  return {
    name:
      trimmed === ""
        ? "Name the Captain."
        : trimmed.length > CAPTAIN_NAME_MAX
          ? `Keep the name to ${CAPTAIN_NAME_MAX} characters.`
          : null,
    repos: repos.length === 0 ? "Pick at least one repo." : null,
  };
}

/**
 * The bb projects a Captain can direct, in bb's project order: every project
 * except the personal one and the projects Captain threads live in, which
 * hold Captains rather than code.
 */
export function repoChoices(
  projects: readonly { id: string; name: string; isPersonal: boolean }[],
  captainProjectIds: ReadonlySet<string>,
): RepoChoice[] {
  return projects
    .filter((project) => !project.isPersonal && !captainProjectIds.has(project.id))
    .map((project) => ({ id: project.id, name: project.name }));
}
