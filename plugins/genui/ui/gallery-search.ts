// What the gallery's header lists and finds: the catalog's components group by
// group, and a query matched against their names, groups, summaries and
// example variants, best match first. Pure; GalleryHeader renders it.
import { COMPONENTS, type CatalogComponentSpec, type ComponentGroup, type ComponentName } from "../core/catalog";

/** The order groups appear in the gallery. */
export const GALLERY_GROUPS: readonly ComponentGroup[] = [
  "Layout",
  "Content",
  "Media",
  "Data",
  "Inputs",
  "Widgets",
  "Project",
  "Dev",
  "Manage",
  "Evidence",
  "3D",
];

/** A group's components in catalog order. */
export function componentsIn(group: ComponentGroup): ComponentName[] {
  return (Object.keys(COMPONENTS) as ComponentName[]).filter((name) => COMPONENTS[name].group === group);
}

/** Every component in gallery order: group by group, catalog order within each. */
export const GALLERY_ORDER: readonly ComponentName[] = GALLERY_GROUPS.flatMap(componentsIn);

/** Why a component matched, strongest first. */
export type MatchKind = "prefix" | "name" | "group" | "detail";

export interface ComponentMatch {
  readonly name: ComponentName;
  readonly kind: MatchKind;
  /** Where the query starts in the name, for highlighting; null when it matched elsewhere. */
  readonly at: number | null;
}

const RANK: Record<MatchKind, number> = { prefix: 0, name: 1, group: 2, detail: 3 };

/**
 * The components a query finds, best first: the name starts with it, then
 * contains it, then the group starts with it, then the summary or one of the
 * component's example variants ("funnel" for Chart-funnel.ui) contains it;
 * gallery order within each kind. Case is ignored. A blank query finds
 * nothing: the caller shows everything, unfiltered.
 */
export function searchComponents(
  query: string,
  variants: ReadonlyMap<ComponentName, readonly string[]> = new Map(),
): ComponentMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const found: ComponentMatch[] = [];
  for (const name of GALLERY_ORDER) {
    const spec: CatalogComponentSpec = COMPONENTS[name];
    const at = name.toLowerCase().indexOf(needle);
    let kind: MatchKind | null = null;
    if (at === 0) kind = "prefix";
    else if (at > 0) kind = "name";
    else if (spec.group.toLowerCase().startsWith(needle)) kind = "group";
    else if (
      spec.summary?.toLowerCase().includes(needle) ||
      (variants.get(name) ?? []).some((variant) => variant.toLowerCase().includes(needle))
    ) {
      kind = "detail";
    }
    if (kind !== null) found.push({ name, kind, at: at >= 0 ? at : null });
  }
  // Array.prototype.sort is stable, so gallery order holds within a kind.
  return found.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
}
