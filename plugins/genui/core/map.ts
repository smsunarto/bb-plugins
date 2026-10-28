// Map places as written, read once for the component (ui/components/Map.tsx)
// and its markdown form: name, note, coordinates, the day a stop belongs to
// and the Wikipedia article whose lead photo its card shows. Pure: no React,
// no DOM.
import { fieldsOf, str } from "./fields";
import type { Value } from "./types";

export interface MapPlace {
  readonly name: string;
  readonly note: string | null;
  /** Coordinates given in the spec; null when the name has to be looked up. */
  readonly given: { readonly lat: number; readonly lng: number } | null;
  /** The day's label ("Day 2" for `day: 2`, the text for `day: "Sat 14"`); null before the first place with a day. */
  readonly day: string | null;
  /** The English Wikipedia article whose lead photo the card shows. */
  readonly wiki: string | null;
}

/** Day labels past this are cut: they sit in a one-line legend. */
const MAX_DAY_CHARS = 40;

function dayLabel(value: Value | undefined): string | null {
  const text = str(value)?.trim() ?? null;
  if (text === null) return null;
  return /^\d+$/.test(text) ? `Day ${Number(text)}` : text.slice(0, MAX_DAY_CHARS);
}

/**
 * Each place as written (`{name, lat?, lng?, note?, day?, wiki?}` or a bare
 * name), null where one has no name yet. A place without `day` stays on the
 * day of the place before it, so a day can be named once, on its first stop.
 */
export function readPlaces(items: readonly Value[]): (MapPlace | null)[] {
  let day: string | null = null;
  return items.map((item) => {
    const fields = fieldsOf(item) ?? { name: item };
    const name = str(fields.name)?.trim() ?? "";
    if (name === "") return null;
    day = dayLabel(fields.day) ?? day;
    const { lat, lng } = fields;
    const valid = typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    return {
      name,
      note: str(fields.note)?.trim() || null,
      given: valid ? { lat, lng } : null,
      day,
      wiki: str(fields.wiki)?.trim() || null,
    };
  });
}

export interface DayGroup {
  /** Null for the places before the first day. */
  readonly label: string | null;
  /** Indexes into the places, in the order written. */
  readonly places: readonly number[];
}

/**
 * The places by day, days in the order they first appear. This is the order
 * stops are numbered, listed, joined by the route and dropped by the tour,
 * so a day written in two runs still reads as one.
 */
export function groupByDay(places: readonly (MapPlace | null)[]): DayGroup[] {
  const groups = new Map<string | null, number[]>();
  places.forEach((place, index) => {
    if (place === null) return;
    const group = groups.get(place.day);
    if (group === undefined) groups.set(place.day, [index]);
    else group.push(index);
  });
  return [...groups].map(([label, indexes]) => ({ label, places: indexes }));
}
