import { type CSSProperties, useEffect, useId, useState } from "react";
import { experimental_usePluginId as usePluginId } from "@get-bb/plugin-sdk/app";
import type { DecodedImage } from "../../shared/previews.ts";
import type { ComparisonSide, FileBlobs } from "../../shared/schema.ts";
import { formatBytes } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { RetryButton } from "../notice.tsx";
import {
  SIDE_LABEL,
  Segmented,
  SideCaption,
  type SideUrls,
  sideBytes,
  useLoadFailure,
} from "./common.tsx";
import { decodeImage } from "./decode.ts";

/*
 * Two versions of an image, as GitHub compares them: side by side, swiped
 * across, or faded one over the other. Every format arrives as an `<img>`
 * source, the route's URL for what a browser draws itself, a decoded PNG for
 * game formats such as TGA, PSD, and EXR.
 */

type Mode = "2-up" | "swipe" | "onion";
const MODES: readonly { value: Mode; label: string }[] = [
  { value: "2-up", label: "2-up" },
  { value: "swipe", label: "Swipe" },
  { value: "onion", label: "Onion skin" },
];

type Shown = { src: string; width: number; height: number } | { error: string } | null;

/** A side's drawable source: the URL itself, or the PNG its bytes decode to. */
function useSource(url: string | null, decoded: DecodedImage | null, attempt: number): Shown {
  const pluginId = usePluginId();
  const [shown, setShown] = useState<{ url: string; value: Shown } | null>(null);
  useEffect(() => {
    if (!url || !decoded) return;
    const controller = new AbortController();
    let made: string | null = null;
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok)
          throw new Error((await response.text()) || `The server answered ${response.status}.`);
        const image = await decodeImage(pluginId, decoded, await response.arrayBuffer());
        made = image.url;
        if (controller.signal.aborted) URL.revokeObjectURL(image.url);
        else setShown({ url, value: { src: image.url, width: image.width, height: image.height } });
      } catch (error) {
        if (!controller.signal.aborted)
          setShown({
            url,
            value: { error: error instanceof Error ? error.message : String(error) },
          });
      }
    })();
    return () => {
      controller.abort();
      if (made) URL.revokeObjectURL(made);
    };
    // `attempt` reads again after a failure.
  }, [url, decoded, pluginId, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!url) return null;
  if (!decoded) return { src: url, width: 0, height: 0 };
  return shown?.url === url ? shown.value : null;
}

type Measured = { width: number; height: number };

function Failed({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 p-3 text-[11px] text-destructive-text">
      <p>{reason}</p>
      <RetryButton onRetry={onRetry} />
    </div>
  );
}

/** One side's image. Its parent keys it by URL and attempt, so a failure never outlives either. */
function Picture({
  side,
  shown,
  url,
  onSize,
  onRetry,
  className,
  style,
}: {
  side: ComparisonSide;
  shown: Shown;
  url: string | null;
  onSize: (size: Measured) => void;
  onRetry: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  const reason = useLoadFailure(url, failed);
  if (shown && "error" in shown) return <Failed reason={shown.error} onRetry={onRetry} />;
  if (failed) return <Failed reason={reason ?? ""} onRetry={onRetry} />;
  if (!shown) {
    return (
      <p className="p-3 text-[11px] text-muted-foreground">
        Decoding {SIDE_LABEL[side].toLowerCase()}…
      </p>
    );
  }
  return (
    <img
      src={shown.src}
      alt={`${SIDE_LABEL[side]} version`}
      draggable={false}
      decoding="async"
      className={cn("block max-h-[32rem] max-w-full object-contain", className)}
      style={style}
      onLoad={(event) =>
        onSize({
          width: event.currentTarget.naturalWidth,
          height: event.currentTarget.naturalHeight,
        })
      }
      onError={() => setFailed(true)}
    />
  );
}

function sizeText(size: Measured | undefined, bytes: number | null): string {
  const parts = [
    size ? `${size.width} × ${size.height}` : null,
    bytes === null ? null : formatBytes(bytes),
  ];
  return parts.filter(Boolean).join(" · ");
}

export function ImageDiff({
  urls,
  blobs,
  decoded,
}: {
  urls: SideUrls;
  blobs: FileBlobs;
  decoded: DecodedImage | null;
}) {
  const both = urls.base !== null && urls.head !== null;
  const [mode, setMode] = useState<Mode>("2-up");
  const [position, setPosition] = useState(50);
  const [sizes, setSizes] = useState<Partial<Record<ComparisonSide, Measured>>>({});
  const sliderId = useId();
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt((count) => count + 1);
  const sources = {
    base: useSource(urls.base, decoded, attempt),
    head: useSource(urls.head, decoded, attempt),
  };
  const measure = (side: ComparisonSide) => (size: Measured) =>
    setSizes((current) =>
      current[side]?.width === size.width && current[side]?.height === size.height
        ? current
        : { ...current, [side]: size },
    );
  const shownMode = both ? mode : "2-up";
  const sides = (["base", "head"] as const).filter((side) => urls[side] !== null);
  // Stacked views share one box, the larger image's shape, so both fit it the same way.
  const box = sizes.head ?? sizes.base;

  return (
    <div className="flex flex-col gap-2.5 p-3">
      {both ? (
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="Compare images" options={MODES} value={shownMode} onChange={setMode} />
          {shownMode !== "2-up" ? (
            <label
              htmlFor={sliderId}
              className="flex min-w-40 flex-1 items-center gap-2 text-[11px] text-muted-foreground"
            >
              <span>{shownMode === "swipe" ? "Swipe" : "Opacity"}</span>
              <input
                id={sliderId}
                type="range"
                min={0}
                max={100}
                value={position}
                onChange={(event) => setPosition(Number(event.target.value))}
                className="min-w-0 flex-1 accent-primary"
              />
            </label>
          ) : null}
        </div>
      ) : null}
      {shownMode === "2-up" ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3">
          {sides.map((side) => (
            <figure key={side} className="flex min-w-0 flex-col gap-1.5">
              <div className="cr-checker flex min-h-24 items-center justify-center overflow-hidden rounded-md border border-border">
                <Picture
                  key={`${urls[side]}#${attempt}`}
                  side={side}
                  shown={sources[side]}
                  url={urls[side]}
                  onSize={measure(side)}
                  onRetry={retry}
                />
              </div>
              <figcaption>
                <SideCaption side={side}>
                  {sizeText(sizes[side], sideBytes(blobs, side))}
                </SideCaption>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <figure className="flex min-w-0 flex-col gap-1.5">
          <div className="cr-checker flex justify-center overflow-hidden rounded-md border border-border">
            <div
              className="relative max-h-[32rem] max-w-full"
              style={
                box ? { aspectRatio: `${box.width} / ${box.height}`, width: box.width } : undefined
              }
            >
              {/* Each side covers only its own share, so neither shows through the other's transparent pixels. */}
              <Picture
                key={`${urls.head}#${attempt}`}
                side="head"
                shown={sources.head}
                url={urls.head}
                onSize={measure("head")}
                onRetry={retry}
                className="h-full w-full"
                style={
                  shownMode === "swipe"
                    ? { clipPath: `inset(0 0 0 ${position}%)` }
                    : { opacity: position / 100 }
                }
              />
              <Picture
                key={`${urls.base}#${attempt}`}
                side="base"
                shown={sources.base}
                url={urls.base}
                onSize={measure("base")}
                onRetry={retry}
                className="absolute inset-0 h-full w-full"
                style={
                  shownMode === "swipe"
                    ? { clipPath: `inset(0 ${100 - position}% 0 0)` }
                    : { opacity: 1 - position / 100 }
                }
              />
              {shownMode === "swipe" ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 w-px bg-primary"
                  style={{ left: `${position}%` }}
                />
              ) : null}
            </div>
          </div>
          <figcaption className="flex flex-wrap justify-between gap-2">
            <SideCaption side="base">{sizeText(sizes.base, sideBytes(blobs, "base"))}</SideCaption>
            <SideCaption side="head">{sizeText(sizes.head, sideBytes(blobs, "head"))}</SideCaption>
          </figcaption>
        </figure>
      )}
    </div>
  );
}
