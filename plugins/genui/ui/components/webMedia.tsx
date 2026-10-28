// Photos from the web: ImageSearch (one photo found from a description) and
// Gallery (paths, https URLs and searches mixed, in a grid or a strip), opened
// full size in the shared viewer (viewer.tsx). Searches go to Wikimedia
// Commons through the backend (web/lookups.ts); every found photo is credited
// with its author, licence and Commons page, beside it and in the viewer.
import { useCallback, useEffect, useRef, useState } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { finiteNumber, isObject, list, optionalText, text, type Props } from "../values";
import { useImageSearch, type FoundImage } from "../webLookups";
import { ErrorLine } from "./display";
import { useImageUrl, WebOffLine } from "./media";
import { RISE, useEntrance } from "./motion";
import { useViewer, type Viewable } from "./viewer";

/** A Gallery tile's picture, once it can be shown. */
interface TilePicture {
  readonly url: string;
  readonly alt: string;
  readonly caption: string | null;
  readonly credit: FoundImage | null;
}

/** The viewer's credit line for a found photo. */
const VIEWER_CREDIT = "justify-center text-white/60 [&_a:hover]:text-white";

/** Photo credit: author and licence, linked to the file's Commons page (which holds the full attribution). Map cards use it too. */
export function Credit({ image, compact = false, className }: { image: FoundImage; compact?: boolean; className?: string }) {
  return (
    <p className={cn("flex min-w-0 items-baseline gap-1 text-[11px] leading-4 text-muted-foreground", className)}>
      <span className="min-w-0 truncate" title={`${image.creator} · ${image.license}`}>
        {image.creator} ·{" "}
        {image.licenseUrl === null ? (
          image.license
        ) : (
          <UrlLink href={image.licenseUrl} className="underline-offset-2 hover:text-foreground hover:underline">
            {image.license}
          </UrlLink>
        )}
      </span>
      <span aria-hidden>·</span>
      <UrlLink
        href={image.sourceUrl}
        className="shrink-0 underline-offset-2 hover:text-foreground hover:underline"
        aria-label={`Source: ${image.title} on Wikimedia Commons`}
      >
        {compact ? "Commons" : "Wikimedia Commons"}
      </UrlLink>
    </p>
  );
}

const SKELETON = "animate-pulse bg-surface-recessed motion-reduce:animate-none";
const FRAME = "relative block w-full overflow-hidden rounded-lg border border-border bg-surface-recessed";
const ZOOM_BUTTON =
  "block w-full cursor-zoom-in p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

/** A picture filling its box (cropped to it), faded in once decoded. */
export function Fill({ url, alt, onFailed }: { url: string; alt: string; onFailed: () => void }) {
  const [decoded, setDecoded] = useState<string | null>(null);
  const ready = decoded === url;
  return (
    <>
      {ready ? null : <span aria-hidden className={cn("absolute inset-0", SKELETON)} />}
      <img
        src={url}
        alt={alt}
        decoding="async"
        draggable={false}
        onLoad={() => setDecoded(url)}
        onError={onFailed}
        className={cn(
          "absolute inset-0 size-full object-cover transition-opacity duration-300 motion-reduce:transition-none",
          ready ? "opacity-100" : "opacity-0",
        )}
      />
    </>
  );
}

/** Box shape and width per aspect: portrait and square photos stay narrower than the column. */
const ASPECTS = {
  wide: { box: "aspect-[16/9]", width: "w-full" },
  square: { box: "aspect-square", width: "w-full max-w-sm" },
  tall: { box: "aspect-[3/4]", width: "w-full max-w-xs" },
} as const;

export function ImageSearch({ props }: { props: Props }) {
  const query = text(props.query).trim();
  const alt = optionalText(props.alt)?.trim() || query;
  const aspect = ASPECTS[props.aspect === "square" || props.aspect === "tall" ? props.aspect : "wide"];
  const found = useImageSearch(query);
  const image = useImageUrl(found?.ok ? found.image.url : null);
  const [broken, setBroken] = useState<string | null>(null);
  const url = image.status === "ready" ? image.url : null;
  const credit = found?.ok ? found.image : null;
  const { open, viewer } = useViewer(
    url === null || credit === null ? [] : [{ url, alt, caption: null, credit: <Credit image={credit} className={VIEWER_CREDIT} /> }],
  );

  if (query === "") return <ErrorLine message="ImageSearch needs a description to search for" />;
  if (found !== null && !found.ok) {
    if (found.off) return <WebOffLine what={`Photo of “${query}”`} />;
    return <p className="text-xs leading-5 text-muted-foreground">No photo found for “{query}”.</p>;
  }
  if (image.status === "failed") {
    return image.off ? <WebOffLine what={`Photo of “${query}”`} /> : <ErrorLine message={`Couldn't show the photo of “${query}”: ${image.error}`} />;
  }
  if (url !== null && broken === url) return <ErrorLine message={`Couldn't load the photo of “${query}”`} />;

  return (
    // data-bb-image-preview-ignore: these pictures have their own viewer; image-preview plugins must leave them alone.
    <figure data-bb-image-preview-ignore="" className={cn("m-0 flex min-w-0 flex-col gap-1.5", aspect.width)}>
      <div className={cn(FRAME, aspect.box)}>
        {url === null || credit === null ? (
          <span role="status" aria-label={`Finding a photo of ${query}`} className={cn("absolute inset-0", SKELETON)} />
        ) : (
          <button
            type="button"
            aria-label={`${alt}. View full size`}
            onClick={(event) => open(0, event.currentTarget)}
            className={cn(ZOOM_BUTTON, "absolute inset-0")}
          >
            <Fill url={url} alt={alt} onFailed={() => setBroken(url)} />
          </button>
        )}
      </div>
      {credit === null ? (
        <span aria-hidden className={cn("h-4 w-2/3 rounded", SKELETON)} />
      ) : (
        <figcaption>
          <Credit image={credit} />
        </figcaption>
      )}
      {viewer}
    </figure>
  );
}

/** One Gallery entry, as written. */
interface Entry {
  readonly src: string | null;
  readonly query: string | null;
  readonly caption: string | null;
  readonly alt: string;
}

/** A path or https URL, or `{src|query, caption?, alt?}`; null when the item names no picture. */
function entry(item: unknown): Entry | null {
  if (typeof item === "string") return item.trim() === "" ? null : { src: item.trim(), query: null, caption: null, alt: "" };
  if (!isObject(item)) return null;
  const src = optionalText(item.src)?.trim() || null;
  const query = optionalText(item.query)?.trim() || null;
  if (src === null && query === null) return null;
  const caption = optionalText(item.caption)?.trim() || null;
  return { src, query: src === null ? query : null, caption, alt: optionalText(item.alt)?.trim() || caption || query || "" };
}

/** Above this many pictures (without `columns`) the gallery is one scrolling strip, not a tall grid. */
const STRIP_AFTER = 9;
const GRID_GAP = "0.5rem";

type TileState = { readonly status: "ready"; readonly view: TilePicture } | { readonly status: "pending" } | { readonly status: "off" };

function Tile({
  entry: { src, query, caption, alt },
  onState,
  onOpen,
}: {
  entry: Entry;
  onState: (state: TileState) => void;
  onOpen: (opener: HTMLButtonElement) => void;
}) {
  const rise = useEntrance<HTMLElement>(RISE);
  const found = useImageSearch(query ?? "");
  const credit = found?.ok ? found.image : null;
  const image = useImageUrl(src ?? credit?.url ?? null);
  const [broken, setBroken] = useState<string | null>(null);
  const url = image.status === "ready" && broken !== image.url ? image.url : null;
  const off = (found !== null && !found.ok && found.off === true) || (image.status === "failed" && image.off);
  const failure =
    found !== null && !found.ok && !off
      ? `No photo found for “${query}”`
      : image.status === "failed" && !off
        ? image.error
        : image.status === "ready" && broken === image.url
          ? "Couldn't load this picture"
          : null;

  useEffect(() => {
    onState(url !== null ? { status: "ready", view: { url, alt, caption, credit } } : off ? { status: "off" } : { status: "pending" });
  }, [url, alt, caption, credit, off, onState]);

  const label = caption ?? alt;
  return (
    <figure ref={rise} className="m-0 flex min-w-0 flex-col gap-1.5">
      <div className={cn(FRAME, "aspect-[4/3]")}>
        {url !== null ? (
          <button
            type="button"
            aria-label={label === "" ? "View full size" : `${label}. View full size`}
            onClick={(event) => onOpen(event.currentTarget)}
            className={cn(ZOOM_BUTTON, "absolute inset-0")}
          >
            <Fill url={url} alt={alt} onFailed={() => setBroken(url)} />
          </button>
        ) : off || failure !== null ? (
          <span className="absolute inset-0 flex items-center justify-center p-3 text-center text-[11px] leading-4 text-muted-foreground">
            {off ? "Web lookups are off" : failure}
          </span>
        ) : (
          <span role="status" aria-label={label === "" ? "Loading picture" : `Loading ${label}`} className={cn("absolute inset-0", SKELETON)} />
        )}
      </div>
      {caption === null && credit === null ? null : (
        <figcaption className="flex min-w-0 flex-col gap-0.5">
          {caption === null ? null : <span className="line-clamp-2 text-xs leading-4 text-foreground">{caption}</span>}
          {credit === null ? null : <Credit image={credit} compact />}
        </figcaption>
      )}
    </figure>
  );
}

export function Gallery({ props }: { props: Props }) {
  const items = list(props.images);
  const entries = items.map(entry);
  const requested = finiteNumber(props.columns);
  const columns = requested === null ? null : Math.min(6, Math.max(1, Math.round(requested)));
  const shown = entries.flatMap((item, index) => (item === null ? [] : [{ item, index }]));
  const strip = columns === null && shown.length > STRIP_AFTER;
  const [states, setStates] = useState<ReadonlyMap<number, TileState>>(() => new Map());
  const reporters = useRef(new Map<number, (state: TileState) => void>());

  /** A stable state callback per tile, so tiles don't re-report on every render. */
  const reporter = useCallback((index: number) => {
    let report = reporters.current.get(index);
    if (report === undefined) {
      report = (state: TileState) =>
        setStates((previous) => {
          const before = previous.get(index);
          if (before?.status === state.status && (state.status !== "ready" || (before.status === "ready" && before.view.url === state.view.url && before.view.credit === state.view.credit))) {
            return previous;
          }
          return new Map(previous).set(index, state);
        });
      reporters.current.set(index, report);
    }
    return report;
  }, []);

  const views = shown.flatMap(({ index }) => {
    const state = states.get(index);
    return state?.status === "ready" ? [{ index, view: state.view }] : [];
  });
  const { open, viewer } = useViewer(
    views.map(({ view: { url, alt, caption, credit } }): Viewable => ({
      url,
      alt,
      caption,
      credit: credit === null ? undefined : <Credit image={credit} className={VIEWER_CREDIT} />,
    })),
  );

  if (items.length === 0) return <ErrorLine message="Gallery needs images: paths, https URLs or {query} searches" />;
  // While streaming, the last item may not have its src or query yet.
  const unusable = entries.findIndex((item, index) => item === null && index < entries.length - 1);
  const allOff = shown.length > 0 && shown.every(({ index }) => states.get(index)?.status === "off");
  const count = shown.length;
  const auto = count === 1 ? 1 : count === 2 || count === 4 ? 2 : 3;
  const template = `repeat(auto-fill,minmax(max(min(8rem,100%),calc((100% - ${(columns ?? auto) - 1} * ${GRID_GAP}) / ${columns ?? auto})),1fr))`;

  return (
    <div data-bb-image-preview-ignore="" className="@container flex min-w-0 flex-col gap-2">
      {unusable === -1 ? null : <ErrorLine message={`Gallery item ${unusable + 1} needs a src (path or https URL) or a query`} />}
      <div
        role="list"
        aria-label="Gallery"
        className={
          strip
            ? "flex min-w-0 snap-x snap-mandatory gap-2 overflow-x-auto pb-1.5 [scrollbar-width:thin]"
            : "grid min-w-0 gap-2"
        }
        style={strip ? undefined : { gridTemplateColumns: template }}
      >
        {shown.map(({ item, index }) => (
          <div role="listitem" key={index} className={strip ? "w-44 shrink-0 snap-start @md:w-52" : "min-w-0"}>
            <Tile
              entry={item}
              onState={reporter(index)}
              onOpen={(button) => open(views.findIndex((view) => view.index === index), button)}
            />
          </div>
        ))}
      </div>
      {allOff ? <WebOffLine what="Gallery pictures" /> : null}
      {viewer}
    </div>
  );
}
