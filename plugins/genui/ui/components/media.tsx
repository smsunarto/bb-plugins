// Images. Every image, a file of the thread (workspace or
// `$BB_THREAD_STORAGE/…`) or an https URL, is read through the plugin
// backend: files confined to the thread, https images through the
// address-checked proxy that the webLookups setting switches off.
import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { useUiRuntime, type ImageSize, type ImageUrl } from "../runtime";
import { optionalText, text, type Props } from "../values";
import { ErrorLine } from "./display";
import { useViewer } from "./viewer";

type Source =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "invalid"; readonly error: string };

/** What `src` names: an https URL, a thread file (no scheme), or something refused. */
export function imageSource(src: string): Source {
  if (src === "") return { kind: "invalid", error: "This image has no src" };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(src)?.[1]?.toLowerCase();
  // `C:\…` is a Windows path, not a URL scheme.
  if (scheme === undefined || /^[a-z]:[\\/]/i.test(src)) return { kind: "file", path: src };
  if (scheme !== "https") {
    return { kind: "invalid", error: `Images must be https URLs or file paths; ${scheme}: links can't be shown` };
  }
  try {
    return { kind: "url", url: new URL(src).href };
  } catch {
    return { kind: "invalid", error: `Invalid image URL: ${src}` };
  }
}

export type ImageState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "failed"; readonly error: string; readonly off: boolean };

/** What the runtime reads for `source`: its URL or its path; null when there is nothing to read. */
function imageTarget(source: Source | null): string | null {
  return source?.kind === "url" ? source.url : source?.kind === "file" ? source.path : null;
}

/**
 * `target` (a path or an https URL) read through the runtime; null until it
 * arrives or when there is none. An image this page already read is there
 * on the first render, so a remounted block doesn't show a placeholder
 * first; until one arrives, the block holds the height it last settled at.
 * A changed target never shows the previous image.
 */
export function useReadImage(target: string | null): ImageUrl | null {
  const { loadImage } = useUiRuntime();
  const [loaded, setLoaded] = useState<{ readonly target: string; readonly image: ImageUrl } | null>(() => {
    const image = target === null ? null : (loadImage?.peek(target) ?? null);
    return target === null || image === null ? null : { target, image };
  });
  const image = loaded !== null && loaded.target === target ? loaded.image : target === null ? null : (loadImage?.peek(target) ?? null);
  const waiting = target !== null && loadImage !== null && image === null;

  useEffect(() => {
    if (target === null || loadImage === null) return;
    let live = true;
    void loadImage(target).then((image) => {
      if (live) setLoaded((previous) => (previous?.target === target && previous.image === image ? previous : { target, image }));
    });
    return () => {
      live = false;
    };
  }, [target, loadImage]);
  useHeightHold(waiting);

  return image;
}

/**
 * While `active` (a picture being read or decoded), the block keeps the
 * height it last settled at and remembers no other (`UiRuntime.holdHeight`).
 */
export function useHeightHold(active: boolean): void {
  const { holdHeight } = useUiRuntime();
  // Before the browser lays the block out, so no height of the placeholder is remembered as the block's.
  useLayoutEffect(() => (active ? holdHeight() : undefined), [active, holdHeight]);
}

/**
 * `src` (a path or an https URL) as a URL the page can show, read through
 * the runtime; null src (not known yet) stays loading. A changed src never
 * shows the previous image.
 */
export function useImageUrl(src: string | null): ImageState {
  const { loadImage } = useUiRuntime();
  const source = useMemo(() => (src === null ? null : imageSource(src.trim())), [src]);
  const image = useReadImage(imageTarget(source));

  if (source === null) return { status: "loading" };
  if (source.kind === "invalid") return { status: "failed", error: source.error, off: false };
  if (loadImage === null) return { status: "failed", error: `Images can't be shown here: ${src}`, off: false };
  if (image === null) return { status: "loading" };
  return image.ok ? { status: "ready", url: image.url } : { status: "failed", error: image.error, off: image.off === true };
}

/**
 * The box Image shows a picture of `size` in, sized as the picture itself
 * was: as wide as it is (also to a table cell or a flex item sizing to its
 * content), down to the column's width and to the width at which it is
 * max-h-96 tall, never stretched. Known before the picture arrives, the box
 * is laid out at its final size from the first frame.
 */
function pictureBox({ width, height }: ImageSize): CSSProperties {
  return { aspectRatio: `${width} / ${height}`, width: `${width}px`, maxWidth: `min(100%, ${(24 * width) / height}rem)` };
}

/**
 * The natural size `picture` decoded at, when it lays out at that size: a
 * raster's pixels. Null for an SVG, whose reported size (a default 150 px
 * tall at its viewBox ratio, or 300x150) isn't the size it is shown at.
 */
export function decodedSize(picture: HTMLImageElement): ImageSize | null {
  if (picture.naturalWidth <= 0 || picture.naturalHeight <= 0 || /^data:image\/svg\+xml[;,]/i.test(picture.src)) return null;
  return { width: picture.naturalWidth, height: picture.naturalHeight };
}

/** The one quiet line web media show when the webLookups setting is off; `what` names the thing ("Map"). */
export function WebOffLine({ what }: { what: string }) {
  return (
    <p className="text-xs leading-5 text-muted-foreground">
      {what}: not shown, because web lookups are off in the Generative UI plugin settings.
    </p>
  );
}

const SURFACE = "relative flex min-w-0 justify-center overflow-hidden rounded-lg border border-border bg-surface-recessed";

/** A picture the browser decoded (or couldn't), with its natural size when it has one. */
type Decoded = { readonly url: string; readonly ok: boolean; readonly size: ImageSize | null };

/** One picture; pressing it opens it full screen, where a file can also be opened in BB. */
export function Image({ props }: { props: Props }) {
  const src = text(props.src).trim();
  const alt = optionalText(props.alt)?.trim() ?? "";
  const source = useMemo(() => imageSource(src), [src]);
  const target = imageTarget(source);
  const { loadImage } = useUiRuntime();
  const image = useImageUrl(src);
  const url = image.status === "ready" ? image.url : null;
  // The natural size it decoded at before, here or on an earlier page.
  const remembered = target === null ? null : (loadImage?.size(target) ?? null);
  // Already read in this page and of a known size: shown on the first frame, without a fade.
  const [decoded, setDecoded] = useState<Decoded | null>(() => (url !== null && remembered !== null ? { url, ok: true, size: remembered } : null));
  const { open, viewer } = useViewer(
    url === null ? [] : [{ url, alt, caption: null, path: source.kind === "file" ? source.path : undefined }],
  );
  // Read but not decoded yet: the box may still be the placeholder.
  useHeightHold(url !== null && decoded?.url !== url);

  if (image.status === "failed") {
    return image.off ? <WebOffLine what="Image" /> : <ErrorLine message={`Couldn't show ${src}: ${image.error}`} />;
  }
  const result = url !== null && decoded?.url === url ? decoded : null;
  if (result !== null && !result.ok) return <ErrorLine message={`Couldn't load the image at ${src}`} />;
  const ready = result !== null;
  const size = result !== null ? result.size : remembered;
  const onLoad = (picture: HTMLImageElement) => {
    if (url === null) return;
    const natural = decodedSize(picture);
    if (natural !== null && target !== null) loadImage?.rememberSize(target, natural);
    setDecoded((previous) =>
      previous?.url === url && previous.ok && previous.size?.width === natural?.width && previous.size?.height === natural?.height
        ? previous
        : { url, ok: true, size: natural },
    );
  };

  return (
    <>
      <button
        type="button"
        disabled={!ready}
        aria-label={alt === "" ? "View image full size" : `${alt}. View full size`}
        onClick={(event) => open(0, event.currentTarget)}
        className={cn(SURFACE, "w-full cursor-zoom-in p-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default")}
      >
        {ready && size === null ? (
          // A picture without a size of its own (an SVG) lays itself out.
          <img src={url ?? undefined} alt={alt} decoding="async" className="block h-auto max-h-96 max-w-full object-contain" />
        ) : (
          // Of a known size, the box is the picture's from the first frame; otherwise a placeholder until it decodes.
          <span className={cn("relative block", size === null && "h-48 w-full")} style={size === null ? undefined : pictureBox(size)}>
            {ready ? null : (
              <span
                role="status"
                aria-label={alt === "" ? "Loading image" : `Loading image: ${alt}`}
                className="absolute inset-0 animate-pulse motion-reduce:animate-none"
              />
            )}
            {url === null ? null : (
              <img
                src={url}
                alt={alt}
                decoding="async"
                onLoad={(event) => onLoad(event.currentTarget)}
                onError={() => {
                  // Not kept for the page, so the block reads the file again when it mounts again.
                  if (target !== null) loadImage?.forget(target);
                  setDecoded({ url, ok: false, size: null });
                }}
                className={cn(
                  "absolute inset-0 size-full object-contain transition-opacity duration-200 motion-reduce:transition-none",
                  ready ? "opacity-100" : "opacity-0",
                )}
              />
            )}
          </span>
        )}
      </button>
      {/* Outside the button: the viewer's clicks bubble through the React tree. */}
      {viewer}
    </>
  );
}
