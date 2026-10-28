// References: things the answer points at. Entity is a product, place,
// person or organisation card that opens a detail view; Sources lists the
// links an answer drew on; Hotspots numbers points of interest on an image.
// Images, https or files, load only through the runtime's loadImage; links
// open only through the OpenUrl action.
import {
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Button as BaseButton } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { CardDepthContext, useUiRuntime } from "../runtime";
import { list, optionalText, text, type Props } from "../values";
import { actionIntent } from "./action-logic";
import { KeyValue } from "./content";
import { keyValuePairs } from "./content-model";
import { ErrorLine } from "./display";
import { ActionHint, CAPTION, FOCUS_RING } from "./inputs";
import { decodedSize, useHeightHold, useReadImage } from "./media";
import { FADE, reducedMotion, RISE, SMOOTH_HEIGHT_CLASS, useEntrance, useSmoothHeight } from "./motion";
import {
  domainOf,
  entityKind,
  hotspotPoints,
  imageRef,
  inlineFacts,
  parseUrl,
  sourceLinks,
  type EntityKind,
  type HotspotPoint,
  type SourceLink,
} from "./references-model";
import { ExpandButton, useViewer } from "./viewer";

// ---------------------------------------------------------------------------
// Shared

type Picture =
  | { readonly status: "none" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "error"; readonly error: string };

/** An image `src` as a URL the page may show, loaded through the runtime (never fetched directly). */
function usePicture(src: string): Picture {
  const { loadImage } = useUiRuntime();
  const ref = useMemo(() => imageRef(src), [src]);
  const image = useReadImage(ref.kind === "load" ? ref.src : null);
  if (ref.kind === "none") return { status: "none" };
  if (ref.kind === "invalid") return { status: "error", error: ref.error };
  if (loadImage === null) return { status: "error", error: `Images can't be shown here: ${ref.src}` };
  if (image === null) return { status: "loading" };
  return image.ok ? { status: "ready", url: image.url } : { status: "error", error: `Couldn't show ${ref.src}: ${image.error}` };
}

/** Opens `href` through the runtime's OpenUrl action, which owns the scheme check and the user's browser choice. */
function useOpenUrl(): (href: string) => void {
  const { run } = useUiRuntime();
  return (href) => void run([{ kind: "action", type: "openUrl", url: href }]);
}

/** The number on a source, pin or list row. */
const MARKER = "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold leading-none tabular-nums";

// ---------------------------------------------------------------------------
// Entity

/** Line glyphs (lucide geometry) for the kinds BB's icon set has no exact glyph for; drawn in currentColor. */
const KIND_GLYPH: Record<EntityKind, ReactNode> = {
  product: (
    <>
      <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
      <path d="M12 22V12" />
      <path d="m3.3 7 7.7 4.73a2 2 0 0 0 2 0L20.7 7" />
      <path d="m7.5 4.27 9 5.15" />
    </>
  ),
  place: (
    <>
      <path d="M20 10c0 5-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 15 4 10a8 8 0 0 1 16 0" />
      <circle cx="12" cy="10" r="3" />
    </>
  ),
  person: (
    <>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  org: (
    <>
      <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
      <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
      <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
      <path d="M10 6h4M10 10h4M10 14h4M10 18h4" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>
  ),
  other: null,
};

const KIND_LABEL: Record<EntityKind, string> = {
  product: "Product",
  place: "Place",
  person: "Person",
  org: "Organisation",
  link: "Link",
  other: "",
};

function KindGlyph({ kind, className }: { kind: EntityKind; className?: string }) {
  if (KIND_GLYPH[kind] === null) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {KIND_GLYPH[kind]}
    </svg>
  );
}

/** Facts shown on the card; the rest wait in the detail view. */
const CARD_FACTS = 3;

/**
 * A card for one thing: thumbnail, kind, name, note and its first facts.
 * At 18rem and wider (a row of its own, even on a phone) it is a list row
 * with a square thumbnail; narrower (a Grid, Row or Carousel tile) the picture tops the card, so several read
 * as a product or place grid. Tapping it opens the detail view: the picture
 * large, every fact, and the link. The note on the card is a preview: its
 * links work in the detail view.
 */
export function Entity({ props }: { props: Props }) {
  const depth = useContext(CardDepthContext);
  const fade = useEntrance<HTMLDivElement>(FADE);
  const openUrl = useOpenUrl();
  const name = text(props.name).trim();
  const kind = entityKind(props.kind);
  const note = optionalText(props.note)?.trim() || null;
  const pairs = keyValuePairs(props.facts);
  const facts = pairs ?? [];
  const shownFacts = inlineFacts(facts, CARD_FACTS);
  const rawUrl = text(props.url).trim();
  const link = parseUrl(rawUrl, ["http", "https"]);
  const picture = usePicture(text(props.image));
  const [decoded, setDecoded] = useState<{ readonly url: string; readonly ok: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const url = picture.status === "ready" ? picture.url : null;
  const shown = url !== null && decoded?.url === url && decoded.ok;
  // The detail dialog is modal: it closes while its picture is full screen and comes back after.
  const backToDetail = useRef(false);
  const { open: view, viewer } = useViewer(url === null || !shown ? [] : [{ url, alt: name, caption: name }], () => {
    if (backToDetail.current) setOpen(true);
    backToDetail.current = false;
  });

  if (name === "") return <ErrorLine message="Entity needs a name" />;

  const settle = (ok: boolean) => {
    if (url !== null && decoded?.url !== url) setDecoded({ url, ok });
  };
  const decodeFailed = url !== null && decoded?.url === url && !decoded.ok;
  const hasPicture = picture.status === "loading" || (url !== null && !decodeFailed);
  const problems = [
    pairs === null ? "Entity facts must be an object or a list of [label, value] pairs" : null,
    rawUrl !== "" && link === null ? `Entity url must be an http(s) link: ${rawUrl}` : null,
    picture.status === "error" ? picture.error : null,
    decodeFailed ? `Couldn't load the image at ${text(props.image)}` : null,
  ].filter((problem) => problem !== null);
  const openable = hasPicture || facts.length > 0 || link !== null || note !== null;

  const card = (
    // The image-preview plugin restyles chat <img>s into zoomable thumbnails; this layout owns its pictures.
    <article
      data-bb-image-preview-ignore=""
      className={cn(
        "relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg text-sm text-foreground transition-colors duration-150 hover:duration-0 motion-reduce:transition-none",
        "@min-[18rem]:flex-row @min-[18rem]:items-center @min-[18rem]:gap-3 @min-[18rem]:p-2.5",
        depth > 0 ? "bg-surface-recessed" : "border border-border bg-background",
        openable && (depth > 0 ? "hover:bg-state-hover" : "hover:bg-surface-recessed"),
        openable && "has-[button:focus-visible]:ring-1 has-[button:focus-visible]:ring-ring",
      )}
    >
      <div
        className={cn(
          "relative shrink-0 overflow-hidden bg-muted",
          "@min-[18rem]:size-16 @min-[18rem]:rounded-md",
          hasPicture ? "aspect-[4/3] w-full @min-[18rem]:aspect-auto" : "hidden @min-[18rem]:flex @min-[18rem]:items-center @min-[18rem]:justify-center",
        )}
      >
        {hasPicture ? (
          <>
            {shown ? null : <div aria-hidden className="absolute inset-0 animate-pulse motion-reduce:animate-none" />}
            {url === null ? null : (
              <img
                src={url}
                alt=""
                decoding="async"
                referrerPolicy="no-referrer"
                onLoad={() => settle(true)}
                onError={() => settle(false)}
                // Opacity inline, never a toggled class: BB's image preview rewrites an <img>'s class from a stale copy.
                style={{ opacity: shown ? 1 : 0 }}
                className="absolute inset-0 size-full object-cover transition-opacity duration-300 motion-reduce:transition-none"
              />
            )}
            {/* The card opens the detail; the picture alone opens full size from its corner. */}
            {shown ? <ExpandButton label={`View the picture of ${name} full size`} onOpen={(button) => view(0, button)} className="right-1.5 top-1.5" /> : null}
          </>
        ) : (
          // A monogram stands in for a missing picture in the list layout.
          <span aria-hidden className="text-lg font-semibold uppercase text-muted-foreground">
            {Array.from(name)[0]}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-3 pb-3 pt-2.5 @min-[18rem]:p-0">
        <div className="flex min-w-0 items-start gap-1.5">
          <KindGlyph kind={kind} className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" />
          {openable ? (
            <DialogTrigger asChild>
              <button
                type="button"
                aria-label={KIND_LABEL[kind] === "" ? name : `${name}, ${KIND_LABEL[kind].toLowerCase()}`}
                className="min-w-0 cursor-pointer text-left font-medium leading-5 text-foreground [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
              >
                {name}
              </button>
            </DialogTrigger>
          ) : (
            <span className="min-w-0 font-medium leading-5 [overflow-wrap:anywhere]">{name}</span>
          )}
        </div>
        {note === null ? null : (
          <Markdown
            content={note}
            className="pointer-events-none line-clamp-2 min-w-0 text-xs leading-4 text-muted-foreground [&_*]:m-0 [&_*]:text-xs [&_*]:leading-4"
          />
        )}
        {shownFacts.length === 0 ? null : (
          <p className="m-0 flex min-w-0 flex-wrap gap-x-2.5 gap-y-0.5 text-xs leading-4">
            {shownFacts.map((fact, index) => (
              <span key={index} className="min-w-0 [overflow-wrap:anywhere]">
                {fact.label === "" ? null : <span className="text-muted-foreground">{fact.label} </span>}
                <span className="font-medium tabular-nums text-foreground">{fact.value}</span>
              </span>
            ))}
          </p>
        )}
      </div>
      {openable ? (
        <Icon
          name="ChevronRight"
          aria-hidden
          className="hidden size-4 shrink-0 text-muted-foreground @min-[18rem]:block"
        />
      ) : null}
    </article>
  );

  return (
    <div ref={fade} className="@container flex min-w-0 flex-1 flex-col gap-1">
      {openable ? (
        <Dialog open={open} onOpenChange={setOpen}>
          {card}
          {open ? (
            <DialogContent
              className="max-h-[min(88vh,52rem)] gap-4 overflow-y-auto outline-none sm:max-w-xl"
              // Focus the dialog, not its link button: Enter must not leave the app by accident.
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                if (event.target instanceof HTMLElement) event.target.focus({ preventScroll: true });
              }}
              {...(note === null ? { "aria-describedby": undefined } : {})}
            >
              {url !== null && shown ? (
                <button
                  type="button"
                  data-bb-image-preview-ignore=""
                  aria-label={`View the picture of ${name} full size`}
                  onClick={() => {
                    backToDetail.current = true;
                    setOpen(false);
                    view(0, null);
                  }}
                  className={cn("flex cursor-zoom-in justify-center overflow-hidden rounded-lg bg-surface-recessed", FOCUS_RING)}
                >
                  <img
                    src={url}
                    alt={name}
                    referrerPolicy="no-referrer"
                    className="block max-h-[min(50vh,28rem)] w-auto max-w-full object-contain"
                  />
                </button>
              ) : null}
              <DialogHeader className="min-w-0 gap-1 space-y-0 pr-6">
                {KIND_LABEL[kind] === "" ? null : (
                  <span className="flex items-center gap-1.5 text-xs leading-5 text-muted-foreground">
                    <KindGlyph kind={kind} className="size-3.5 shrink-0" />
                    {KIND_LABEL[kind]}
                  </span>
                )}
                <DialogTitle className="text-[17px] font-semibold leading-6 tracking-[-0.01em] [overflow-wrap:anywhere]">
                  {name}
                </DialogTitle>
                {note === null ? null : (
                  <DialogDescription asChild>
                    <div className="min-w-0 text-foreground">
                      <Markdown content={note} className="min-w-0 text-sm [&>:first-child]:mt-0 [&>:last-child]:mb-0" />
                    </div>
                  </DialogDescription>
                )}
              </DialogHeader>
              {facts.length === 0 ? null : <KeyValue props={{ pairs: props.facts ?? null }} />}
              {link === null ? null : (
                <DialogFooter>
                  <ActionHint hint={actionIntent([{ kind: "action", type: "openUrl", url: link.href }]).hint}>
                    <BaseButton type="button" size="sm" onClick={() => openUrl(link.href)} className="min-w-0">
                      <span className="truncate">Open {domainOf(link)}</span>
                      <Icon name="ExternalLink" aria-hidden />
                    </BaseButton>
                  </ActionHint>
                </DialogFooter>
              )}
            </DialogContent>
          ) : null}
        </Dialog>
      ) : (
        card
      )}
      {problems.map((problem) => (
        <ErrorLine key={problem} message={problem} />
      ))}
      {viewer}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sources

function SourceRow({ link, onOpen }: { link: Extract<SourceLink, { ok: true }>; onOpen: (event: MouseEvent) => void }) {
  const ref = useEntrance<HTMLLIElement>(RISE);
  return (
    <li ref={ref} className="min-w-0">
      <a
        href={link.href}
        title={link.href}
        onClick={onOpen}
        className={cn(
          "group/source grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-sm py-1.5 text-foreground no-underline",
          FOCUS_RING,
        )}
      >
        <span
          className={cn(
            MARKER,
            "bg-surface-recessed text-muted-foreground transition-colors duration-150 group-hover/source:bg-foreground group-hover/source:text-background group-hover/source:duration-0 motion-reduce:transition-none",
          )}
        >
          {link.number}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium leading-5 underline-offset-2 group-hover/source:underline">
            {link.title}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
            <Icon name="Globe" aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{link.path === null ? link.domain : `${link.domain}/${link.path}`}</span>
          </span>
          {link.note === null ? null : (
            <span className="line-clamp-2 text-xs leading-4 text-muted-foreground">{link.note}</span>
          )}
        </span>
        <Icon
          name="ExternalLink"
          aria-hidden
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/source:opacity-100 group-focus-visible/source:opacity-100 pointer-coarse:hidden"
        />
      </a>
    </li>
  );
}

function SourceChip({ link, onOpen }: { link: Extract<SourceLink, { ok: true }>; onOpen: (event: MouseEvent) => void }) {
  const ref = useEntrance<HTMLLIElement>(RISE);
  return (
    <li ref={ref} className="flex min-w-0 max-w-full">
      <a
        href={link.href}
        title={link.path === null ? link.href : `${link.domain}/${link.path}`}
        onClick={onOpen}
        className={cn(
          "inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-surface-recessed pl-1.5 pr-3 text-xs text-foreground no-underline transition-colors duration-150 hover:bg-state-hover hover:duration-0 motion-reduce:transition-none",
          FOCUS_RING,
        )}
      >
        <span className={cn(MARKER, "bg-background text-muted-foreground")}>{link.number}</span>
        <span className="truncate">{link.title}</span>
      </a>
    </li>
  );
}

/**
 * Numbered links, numbered as written so `[2]` in the prose is the second.
 * Rows (title, domain, note) when any link carries a note; compact chips when
 * they are bare. https only; a refused link keeps its number and says why.
 */
export function Sources({ props }: { props: Props }) {
  const labelId = useId();
  const openUrl = useOpenUrl();
  const links = sourceLinks(list(props.links));
  if (links.length === 0) return null;
  const rows = links.some((link) => link.ok && link.note !== null);
  const onOpen = (href: string) => (event: MouseEvent) => {
    // The runtime opens it in the user's browser; the anchor is for semantics and copy-link.
    event.preventDefault();
    openUrl(href);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span id={labelId} className={CAPTION}>
        Sources
      </span>
      <ol
        aria-labelledby={labelId}
        className={cn("m-0 flex min-w-0 list-none p-0", rows ? "flex-col" : "flex-wrap gap-1.5 pt-0.5")}
      >
        {links.map((link) =>
          link.ok ? (
            rows ? (
              <SourceRow key={link.number} link={link} onOpen={onOpen(link.href)} />
            ) : (
              <SourceChip key={link.number} link={link} onOpen={onOpen(link.href)} />
            )
          ) : (
            <li
              key={link.number}
              className={cn("flex min-w-0 items-center gap-2.5", rows ? "py-1.5" : "h-8 max-w-full")}
            >
              <span className={cn(MARKER, "bg-destructive/10 text-destructive")}>{link.number}</span>
              <span className="truncate text-xs text-destructive" title={link.error}>
                {link.error}
              </span>
            </li>
          ),
        )}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hotspots

/** The tallest the image is drawn, in rem; wide images fill the width first. */
const HOTSPOT_MAX_HEIGHT_REM = 28;

/** Half a pin's 32 px touch target: pin centers stay this far inside the image's edges. */
const PIN_INSET = "1rem";

function Pin({
  point,
  selected,
  lit,
  rowId,
  onSelect,
  onLight,
}: {
  point: HotspotPoint;
  selected: boolean;
  lit: boolean;
  rowId: string;
  onSelect: () => void;
  onLight: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${point.number}. ${point.title}`}
      aria-expanded={point.text === null ? undefined : selected}
      aria-pressed={point.text === null ? selected : undefined}
      aria-controls={rowId}
      onClick={onSelect}
      onPointerEnter={() => onLight(true)}
      onPointerLeave={() => onLight(false)}
      onFocus={() => onLight(true)}
      onBlur={() => onLight(false)}
      style={{
        left: `clamp(${PIN_INSET}, ${point.x}%, calc(100% - ${PIN_INSET}))`,
        top: `clamp(${PIN_INSET}, ${point.y}%, calc(100% - ${PIN_INSET}))`,
      }}
      className={cn(
        "group/pin absolute flex size-8 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full focus-visible:outline-none",
        selected || lit ? "z-[2]" : "z-[1]",
      )}
    >
      <span
        className={cn(
          "flex size-7 items-center justify-center rounded-full text-xs font-semibold leading-none tabular-nums shadow-[0_1px_4px_rgb(0_0_0/0.35)] ring-2 transition-[transform,background-color,color] duration-150 motion-reduce:transition-none group-focus-visible/pin:ring-ring",
          // A hairline of the opposite ink keeps a pin visible on light and dark pictures alike.
          selected ? "bg-foreground text-background ring-background" : "bg-background text-foreground ring-foreground/20",
          lit && "scale-110",
          lit && !selected && "ring-[var(--color-timeline-accent,var(--primary))]",
        )}
      >
        {point.number}
      </span>
    </button>
  );
}

/**
 * An image with numbered pins at x/y percentages. The points are also listed
 * under the image with the same numbers (the path for keyboards and screen
 * readers); a pin or a row opens that point's text in the list, and the two
 * light each other up. Pins are 32 px targets kept inside the image at any
 * width. The image keeps its own aspect ratio, so pins sit where they were put.
 */
export function Hotspots({ props }: { props: Props }) {
  const id = useId();
  const src = text(props.image);
  const picture = usePicture(src);
  const { loadImage } = useUiRuntime();
  const ref = useMemo(() => imageRef(src), [src]);
  // The natural size it decoded at before, here or on an earlier page.
  const remembered = ref.kind === "load" ? (loadImage?.size(ref.src) ?? null) : null;
  const items = list(props.points);
  const { points, problems } = useMemo(() => hotspotPoints(items), [items]);
  const [selected, setSelected] = useState<number | null>(null);
  const [lit, setLit] = useState<number | null>(null);
  const [scrollTo, setScrollTo] = useState<{ readonly number: number } | null>(null);
  const [natural, setNatural] = useState<{ readonly url: string; readonly ratio: number | null } | null>(null);
  const rows = useRef(new Map<number, HTMLLIElement>());
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();

  // A pin opens its row; bring the row's text into view once it is laid out.
  useEffect(() => {
    if (scrollTo === null) return;
    rows.current.get(scrollTo.number)?.scrollIntoView({
      block: "nearest",
      behavior: reducedMotion() ? "auto" : "smooth",
    });
  }, [scrollTo]);

  const url = picture.status === "ready" ? picture.url : null;
  const size = url !== null && natural?.url === url ? natural : null;
  // Read but not decoded yet: the frame may still have the placeholder's ratio.
  useHeightHold(url !== null && natural?.url !== url);
  const settle = (ok: boolean, img: HTMLImageElement) => {
    if (url === null || natural?.url === url) return;
    const { naturalWidth, naturalHeight } = img;
    const own = ok ? decodedSize(img) : null;
    // Not kept for the page, so the block reads the file again when it mounts again.
    if (!ok && ref.kind === "load") loadImage?.forget(ref.src);
    if (own !== null && ref.kind === "load") loadImage?.rememberSize(ref.src, own);
    // An SVG without width/height has no ratio of its own: keep the frame's.
    setNatural({ url, ratio: !ok ? null : naturalWidth > 0 && naturalHeight > 0 ? naturalWidth / naturalHeight : 16 / 9 });
  };
  const failed = size !== null && size.ratio === null;
  const ready = size !== null && size.ratio !== null;
  // Until it decodes, the ratio it had before, so the frame and its pins don't change shape.
  const ratio = size?.ratio ?? (remembered === null ? 16 / 9 : remembered.width / remembered.height);
  const active = points.some((point) => point.number === selected) ? selected : null;
  const { open, viewer } = useViewer(
    url === null || !ready ? [] : [{ url, alt: points.length === 0 ? "Picture" : `Picture with ${points.map((point) => `${point.number}. ${point.title}`).join(", ")}`, caption: null }],
  );

  const toggle = (number: number, fromPin: boolean) => {
    const next = active === number ? null : number;
    setSelected(next);
    if (fromPin && next !== null) setScrollTo({ number: next });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && active !== null) {
      event.stopPropagation();
      setSelected(null);
    }
  };

  let image: ReactNode;
  if (src.trim() === "") image = <ErrorLine message="Hotspots needs an image" />;
  else if (picture.status === "error") image = <ErrorLine message={picture.error} />;
  else if (failed) image = <ErrorLine message={`Couldn't load the image at ${src}`} />;
  else {
    image = (
      <div className="flex min-w-0 justify-center">
        <div
          // Pins are placed on this box: the image-preview plugin must not resize the picture inside it.
          data-bb-image-preview-ignore=""
          className="relative max-w-full"
          style={{ width: `min(100%, ${HOTSPOT_MAX_HEIGHT_REM * ratio}rem)`, aspectRatio: String(ratio) }}
        >
          {ready ? null : (
            <div
              role="status"
              aria-label="Loading image"
              className="absolute inset-0 animate-pulse rounded-lg bg-surface-recessed motion-reduce:animate-none"
            />
          )}
          {url === null ? null : (
            <img
              src={url}
              alt=""
              decoding="async"
              referrerPolicy="no-referrer"
              onLoad={(event) => settle(true, event.currentTarget)}
              onError={(event) => settle(false, event.currentTarget)}
              style={{ opacity: ready ? 1 : 0 }}
              className="absolute inset-0 size-full rounded-lg border border-border object-fill transition-opacity duration-300 motion-reduce:transition-none"
            />
          )}
          {/* The pins are the picture's own taps, so viewing it full size is its own button. */}
          {ready ? <ExpandButton label="View the picture full size" onOpen={(button) => open(0, button)} className="right-2 top-2" /> : null}
          {ready
            ? points.map((point) => (
                <Pin
                  key={point.number}
                  point={point}
                  selected={active === point.number}
                  lit={lit === point.number}
                  rowId={`${id}-row-${point.number}`}
                  onSelect={() => toggle(point.number, true)}
                  onLight={(on) => setLit((current) => (on ? point.number : current === point.number ? null : current))}
                />
              ))
            : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" onKeyDown={onKeyDown}>
      {image}
      {viewer}
      {points.length === 0 ? null : (
        <div ref={outer} className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}>
          <div ref={inner} className="min-w-0">
            <ol aria-label="Points on the image" className="m-0 flex min-w-0 list-none flex-col p-0">
              {points.map((point) => {
                const open = active === point.number;
                const bodyId = `${id}-text-${point.number}`;
                return (
                  <li
                    key={point.number}
                    id={`${id}-row-${point.number}`}
                    ref={(element) => {
                      if (element === null) rows.current.delete(point.number);
                      else rows.current.set(point.number, element);
                    }}
                    className="flex min-w-0 scroll-my-3 flex-col"
                  >
                    <button
                      type="button"
                      aria-expanded={point.text === null ? undefined : open}
                      aria-pressed={point.text === null ? open : undefined}
                      aria-controls={point.text === null ? undefined : bodyId}
                      onClick={() => toggle(point.number, false)}
                      onPointerEnter={() => setLit(point.number)}
                      onPointerLeave={() => setLit((current) => (current === point.number ? null : current))}
                      onFocus={() => setLit(point.number)}
                      onBlur={() => setLit((current) => (current === point.number ? null : current))}
                      className={cn(
                        "flex min-w-0 cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:duration-0 motion-reduce:transition-none",
                        FOCUS_RING,
                        open ? "bg-state-active" : lit === point.number ? "bg-state-hover" : "hover:bg-state-hover",
                      )}
                    >
                      <span
                        className={cn(
                          MARKER,
                          "mt-px transition-colors duration-150 motion-reduce:transition-none",
                          open ? "bg-foreground text-background" : "bg-surface-recessed text-muted-foreground",
                        )}
                      >
                        {point.number}
                      </span>
                      <span className="min-w-0 flex-1 text-sm font-medium leading-5 text-foreground [overflow-wrap:anywhere]">
                        {point.title}
                      </span>
                      {point.text === null ? null : (
                        <Icon
                          name="ChevronRight"
                          aria-hidden
                          className={cn(
                            "mt-[3px] size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                            open && "rotate-90",
                          )}
                        />
                      )}
                    </button>
                    {point.text === null ? null : (
                      <div id={bodyId} hidden={!open} className={cn("min-w-0 pb-2 pl-[2.375rem] pr-2 pt-1", !open && "hidden")}>
                        {open ? (
                          <Markdown
                            content={point.text}
                            className="min-w-0 text-sm text-foreground [&>:first-child]:mt-0 [&>:last-child]:mb-0"
                          />
                        ) : null}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      )}
      {problems.map((problem) => (
        <ErrorLine key={problem} message={problem} />
      ))}
    </div>
  );
}
