import { atom } from "jotai";
import { createSyncedPreferenceAtom } from "./synced-preference-atom.js";

export const expandedThreadIdsAtom = createSyncedPreferenceAtom("expandedThreads");
export const collapsedEnvironmentIdsAtom = createSyncedPreferenceAtom("collapsedEnvironments");
export const shelfFoldsAtom = createSyncedPreferenceAtom("shelfFolds");
export const groupFoldsAtom = createSyncedPreferenceAtom("groupFolds");
export const threadRowActionsAtom = createSyncedPreferenceAtom("rowActions");
export const sidebarOrganizationModeAtom = createSyncedPreferenceAtom("organizationMode");
export const sidebarEnvironmentGroupingAtom = createSyncedPreferenceAtom("environmentGrouping");
export const sidebarGroupByReadStatusAtom = createSyncedPreferenceAtom("groupByReadStatus");
export const sidebarGroupThreadsByEnvironmentAtom = atom((get) => {
  if (get(sidebarGroupByReadStatusAtom)) return false;
  const grouping = get(sidebarEnvironmentGroupingAtom);
  if (grouping !== "auto") return grouping;
  return get(sidebarOrganizationModeAtom) !== "chronological";
});
export const sidebarChronologicalSortAtom = createSyncedPreferenceAtom("chronologicalSort");
export const sidebarSortDirectionAtom = createSyncedPreferenceAtom("sortDirection");
// bb's custom thread sections have no place on a GTD shelf, so their folds are
// never stored; the drag engine still reads this atom for a section drop.
export const sidebarCollapsedThreadSectionsAtom = atom<string[]>([]);

export const sidebarShowProviderIconsAtom = createSyncedPreferenceAtom("showProviderIcons");
export const sidebarShowRowMetadataAtom = createSyncedPreferenceAtom("showRowMetadata");
export const THREAD_ROW_METADATA_EXPERIMENT = "threadRowMetadata";
