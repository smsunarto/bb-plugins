// Everything the plugin fetches from the web, behind the one `webLookups`
// setting: photo search (Wikimedia Commons), Wikipedia lead photos, place
// names to coordinates (Photon), map tiles (OpenStreetMap) and the https
// images a UI shows. All of it runs here, in the BB server, rather than in
// the page: the setting is a real switch, model-written URLs can't make the
// user's browser call hosts on their own network, nothing depends on the
// page's CSP, and one cache serves every client. Results are values; nothing
// here throws to the caller.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { CACHE_MIGRATIONS, WebCache, type CacheEntry } from "./cache";
import { findWikiPhoto, foundImageSchema, pickImage, searchUrl, wikiPhotoSchema, type FoundImage, type WikiPhoto } from "./commons";
import { geocodeUrl, locatedSchema, pickLocation, type Located } from "./geocode";
import { declaresImage, sniffImage } from "./image";
import { parseJson, safeGet, type Fetched, type GetOptions } from "./net";
import { setTimeout as sleep } from "node:timers/promises";

export const MAX_REMOTE_IMAGE_BYTES = 5 * 1024 * 1024;
const CACHE_BYTES = 128 * 1024 * 1024;
const DAY_MS = 86_400_000;
/** OSM's tile policy: honour caching headers, or keep tiles at least 7 days. We keep 7 and revalidate. */
const TILE_TTL_MS = 7 * DAY_MS;
const IMAGE_TTL_MS = 7 * DAY_MS;
const FOUND_TTL_MS = 30 * DAY_MS;
/** Misses are retried sooner: the agent may have misspelled, or the service had a bad moment. */
const MISS_TTL_MS = DAY_MS;
/** Photon is fair-use; one request a second keeps us well inside it. */
const GEOCODE_SPACING_MS = 1_100;
export const MAX_TILE_ZOOM = 19;

export const WEB_SETTINGS = {
  webLookups: {
    type: "boolean",
    label: "Web lookups",
    description:
      "Lets inline UI fetch from the web, through this BB server. ImageSearch and Gallery searches send their search words to Wikimedia Commons (commons.wikimedia.org) and load the photo from upload.wikimedia.org. Map sends the names of places given without coordinates to Photon (photon.komoot.io), loads map tiles from OpenStreetMap (tile.openstreetmap.org), and asks Wikipedia (en.wikipedia.org) and Commons for the lead photo of places that name a Wikipedia article. Images given as https links are fetched from the site in the link. Each request names this plugin in its User-Agent; the service sees this machine's IP address and that request, and nothing else is sent: no cookies, thread text or account details. Answers are cached in this plugin's database. Off: nothing is fetched, and those components say so.",
    default: true,
  },
} as const;

export type WebFailure = { readonly ok: false; readonly error: string; readonly off?: boolean };
export type WebImage = { readonly ok: true; readonly dataUrl: string } | WebFailure;
export type WebSearch = { readonly ok: true; readonly image: FoundImage } | WebFailure;
export type WebPhoto = { readonly ok: true; readonly photo: WikiPhoto } | WebFailure;
export type WebPlace = ({ readonly ok: true } & Located) | WebFailure;

const OFF: WebFailure = { ok: false, off: true, error: "Web lookups are off in the Generative UI plugin settings" };

/** Runs at most `max` tasks at once, the rest in arrival order. */
function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    // The project's lib target (ES2022) predates Promise.withResolvers.
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function dataUrl(mime: string, body: Buffer): string {
  return `data:${mime};base64,${body.toString("base64")}`;
}

function metaOf(entry: CacheEntry): Record<string, unknown> {
  const meta = parseJson(Buffer.from(entry.meta, "utf8"));
  return typeof meta === "object" && meta !== null && !Array.isArray(meta) ? Object.fromEntries(Object.entries(meta)) : {};
}

/** A search or place name as a cache key: case and spacing don't make a new lookup. */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface WebLookups {
  /** An https image as a data URL, through the address-checked proxy. */
  image(url: string): Promise<WebImage>;
  /** The best freely licensed photo for a description. */
  search(query: string): Promise<WebSearch>;
  /** The credited lead photo of an English Wikipedia article, when it has one we can credit. */
  photo(title: string): Promise<WebPhoto>;
  /** Coordinates for a place name, nudged toward `near`. */
  geocode(name: string, near: Located | null): Promise<WebPlace>;
  /** One OpenStreetMap tile as a data URL. */
  tile(z: number, x: number, y: number): Promise<WebImage>;
  /** The setting as last read, for code that can't wait (the agent configuration). */
  isOn(): boolean;
}

export function createWebLookups(bb: BbPluginApi): WebLookups {
  const settings = bb.settings.define(WEB_SETTINGS);
  let migrated: Database.Database | null = null;
  const cache = new WebCache(() => {
    const db = bb.storage.database();
    if (db !== migrated) {
      bb.storage.migrate(db, [...CACHE_MIGRATIONS]);
      migrated = db;
    }
    return db;
  }, CACHE_BYTES);

  const inFlight = new Map<string, Promise<unknown>>();
  /** One fetch per key at a time; concurrent callers share it. */
  function once<T>(key: string, task: () => Promise<T>): Promise<T> {
    const running = inFlight.get(key);
    if (running !== undefined) return running as Promise<T>;
    const started = task().finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
  }

  /** A cache read that never fails the lookup: a broken cache only means fetching again. */
  function cached(key: string): CacheEntry | null {
    try {
      return cache.get(key);
    } catch (cause) {
      bb.log.warn(`web cache read failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    }
  }

  function store(write: () => void): void {
    try {
      write();
    } catch (cause) {
      bb.log.warn(`web cache write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  const enabled = async () => (await settings.get()).webLookups;
  let on: boolean = WEB_SETTINGS.webLookups.default;
  void settings.get().then((current) => {
    on = current.webLookups;
  });
  settings.onChange((next) => {
    on = next.webLookups;
  });
  const images = limiter(4);
  const tiles = limiter(2);
  const api = limiter(2);
  let nextGeocodeAt = 0;

  const imageRequest: GetOptions = {
    accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml;q=0.8",
    maxBytes: MAX_REMOTE_IMAGE_BYTES,
    timeoutMs: 20_000,
  };
  const jsonRequest: GetOptions = { accept: "application/json", maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 };

  async function image(input: string): Promise<WebImage> {
    if (!(await enabled())) return OFF;
    let url: string;
    try {
      url = new URL(input).href;
    } catch {
      return { ok: false, error: "not a valid URL" };
    }
    const key = `img:${url}`;
    return once(key, async (): Promise<WebImage> => {
      const hit = cached(key);
      const hitMime = hit === null ? null : metaOf(hit).mime;
      if (hit !== null && !hit.expired && typeof hitMime === "string") return { ok: true, dataUrl: dataUrl(hitMime, hit.body) };
      const fetched = await images(() => safeGet(url, imageRequest));
      if (!fetched.ok) {
        // A stale copy beats an error when the origin is down.
        return hit !== null && typeof hitMime === "string" ? { ok: true, dataUrl: dataUrl(hitMime, hit.body) } : fetched;
      }
      const mime = sniffImage(fetched.body);
      if (mime === null || !declaresImage(fetched.headers["content-type"])) {
        return { ok: false, error: "the link is not a png, jpeg, gif, webp, avif or svg image" };
      }
      store(() => cache.put(key, fetched.body, JSON.stringify({ mime }), IMAGE_TTL_MS));
      return { ok: true, dataUrl: dataUrl(mime, fetched.body) };
    });
  }

  async function search(query: string): Promise<WebSearch> {
    if (!(await enabled())) return OFF;
    const normalized = normalize(query);
    if (normalized === "") return { ok: false, error: "the search is empty" };
    const key = `search:${normalized}`;
    const notFound: WebFailure = { ok: false, error: `no photo found for “${query.trim()}”` };
    return once(key, async (): Promise<WebSearch> => {
      const hit = cached(key);
      // A cached miss is stored as `image: null`; anything unreadable counts as no entry.
      const parsed = hit === null ? null : foundImageSchema.nullable().safeParse(metaOf(hit).image);
      const remembered = parsed?.success ? parsed.data : null;
      if (hit !== null && !hit.expired && parsed?.success) return remembered === null ? notFound : { ok: true, image: remembered };
      const fetched: Fetched = await api(() => safeGet(searchUrl(normalized), jsonRequest));
      if (!fetched.ok) return remembered !== null ? { ok: true, image: remembered } : fetched;
      const found: FoundImage | null = pickImage(parseJson(fetched.body));
      store(() => cache.put(key, Buffer.alloc(0), JSON.stringify({ image: found }), found === null ? MISS_TTL_MS : FOUND_TTL_MS));
      return found === null ? notFound : { ok: true, image: found };
    });
  }

  async function photo(title: string): Promise<WebPhoto> {
    if (!(await enabled())) return OFF;
    // Titles keep their case: Wikipedia tells "Bath" from "BATH".
    const wanted = title.trim().replace(/\s+/g, " ");
    if (wanted === "") return { ok: false, error: "the place names no Wikipedia article" };
    const key = `wiki:${wanted}`;
    const notFound: WebFailure = { ok: false, error: `no photo to credit in the Wikipedia article “${wanted}”` };
    return once(key, async (): Promise<WebPhoto> => {
      const hit = cached(key);
      const parsed = hit === null ? null : wikiPhotoSchema.nullable().safeParse(metaOf(hit).photo);
      const remembered = parsed?.success ? parsed.data : null;
      if (hit !== null && !hit.expired && parsed?.success) return remembered === null ? notFound : { ok: true, photo: remembered };
      const found = await findWikiPhoto(wanted, (url) => api(() => safeGet(url, jsonRequest)));
      if (!found.ok) return remembered !== null ? { ok: true, photo: remembered } : found;
      store(() => cache.put(key, Buffer.alloc(0), JSON.stringify({ photo: found.photo }), found.photo === null ? MISS_TTL_MS : FOUND_TTL_MS));
      return found.photo === null ? notFound : { ok: true, photo: found.photo };
    });
  }

  async function geocode(name: string, near: Located | null): Promise<WebPlace> {
    if (!(await enabled())) return OFF;
    const normalized = normalize(name);
    if (normalized === "") return { ok: false, error: "the place has no name" };
    const bias = near === null ? "" : `${near.lat.toFixed(1)},${near.lng.toFixed(1)}`;
    const key = `geo:${normalized}|${bias}`;
    const notFound: WebFailure = { ok: false, error: `couldn't find “${name.trim()}” on the map` };
    return once(key, async (): Promise<WebPlace> => {
      const hit = cached(key);
      const parsed = hit === null ? null : locatedSchema.nullable().safeParse(metaOf(hit).place);
      const remembered = parsed?.success ? parsed.data : null;
      if (hit !== null && !hit.expired && parsed?.success) return remembered === null ? notFound : { ok: true, ...remembered };
      const now = Date.now();
      const slot = Math.max(now, nextGeocodeAt);
      nextGeocodeAt = slot + GEOCODE_SPACING_MS;
      if (slot > now) await sleep(slot - now);
      const fetched = await safeGet(geocodeUrl(normalized, near), jsonRequest);
      if (!fetched.ok) return remembered !== null ? { ok: true, ...remembered } : fetched;
      const found = pickLocation(parseJson(fetched.body));
      store(() => cache.put(key, Buffer.alloc(0), JSON.stringify({ place: found }), found === null ? MISS_TTL_MS : FOUND_TTL_MS));
      return found === null ? notFound : { ok: true, ...found };
    });
  }

  async function tile(z: number, x: number, y: number): Promise<WebImage> {
    if (!(await enabled())) return OFF;
    const span = 2 ** z;
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > MAX_TILE_ZOOM || x < 0 || y < 0 || x >= span || y >= span) {
      return { ok: false, error: "no such tile" };
    }
    const key = `tile:${z}/${x}/${y}`;
    return once(key, async (): Promise<WebImage> => {
      const hit = cached(key);
      const meta = hit === null ? {} : metaOf(hit);
      if (hit !== null && !hit.expired) return { ok: true, dataUrl: dataUrl("image/png", hit.body) };
      // An expired tile is revalidated, not refetched blind (OSM tile policy).
      const validators: Record<string, string> = {};
      if (hit !== null && typeof meta.etag === "string") validators["if-none-match"] = meta.etag;
      if (hit !== null && typeof meta.lastModified === "string") validators["if-modified-since"] = meta.lastModified;
      const fetched = await tiles(() =>
        safeGet(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
          accept: "image/png",
          maxBytes: 1024 * 1024,
          timeoutMs: 15_000,
          headers: validators,
        }),
      );
      if (!fetched.ok) return hit !== null ? { ok: true, dataUrl: dataUrl("image/png", hit.body) } : fetched;
      if (fetched.status === 304 && hit !== null) {
        store(() => cache.renew(key, hit.meta, TILE_TTL_MS));
        return { ok: true, dataUrl: dataUrl("image/png", hit.body) };
      }
      if (sniffImage(fetched.body) !== "image/png") return { ok: false, error: "the tile server sent something other than a png" };
      const etag = fetched.headers.etag;
      const lastModified = fetched.headers["last-modified"];
      store(() => cache.put(key, fetched.body, JSON.stringify({ etag, lastModified }), TILE_TTL_MS));
      return { ok: true, dataUrl: dataUrl("image/png", fetched.body) };
    });
  }

  return { image, search, photo, geocode, tile, isOn: () => on };
}
