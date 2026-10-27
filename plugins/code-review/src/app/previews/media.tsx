import { useEffect, useState } from "react";
import type { ComparisonSide, FileBlobs } from "../../shared/schema.ts";
import { formatBytes } from "../format.ts";
import { SideCaption, type SideUrls, sideBytes, useLoadFailure } from "./common.tsx";

/*
 * Sound, video, and fonts, each side in the browser's own player or as set
 * text, so a reviewer hears or sees what changed. A codec the browser lacks
 * (ProRes, HEVC on Linux) says so instead of showing an empty player.
 */

const SIDES = ["base", "head"] as const;

function Player({
  kind,
  side,
  url,
  bytes,
}: {
  kind: "audio" | "video";
  side: ComparisonSide;
  url: string;
  bytes: number | null;
}) {
  const [failed, setFailed] = useState(false);
  const reason = useLoadFailure(url, failed);
  const [duration, setDuration] = useState<number | null>(null);
  const facts = [
    duration !== null && Number.isFinite(duration) ? `${duration.toFixed(2)} s` : null,
    bytes === null ? null : formatBytes(bytes),
  ]
    .filter(Boolean)
    .join(" · ");
  const common = {
    src: url,
    controls: true,
    preload: "metadata" as const,
    onError: () => setFailed(true),
    onLoadedMetadata: (event: { currentTarget: HTMLMediaElement }) =>
      setDuration(event.currentTarget.duration),
  };
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      {failed ? (
        <p className="rounded-md border border-border p-3 text-[11px] text-destructive-text">
          {reason === "The browser could not show this file."
            ? `This browser cannot play this ${kind}.`
            : reason}
        </p>
      ) : kind === "audio" ? (
        // A file under review has no caption track to offer.
        // oxlint-disable-next-line jsx-a11y/media-has-caption
        <audio {...common} className="w-full" />
      ) : (
        // oxlint-disable-next-line jsx-a11y/media-has-caption
        <video
          {...common}
          className="max-h-[28rem] w-full rounded-md border border-border bg-black"
        />
      )}
      <figcaption>
        <SideCaption side={side}>{facts}</SideCaption>
      </figcaption>
    </figure>
  );
}

export function MediaDiff({
  kind,
  urls,
  blobs,
}: {
  kind: "audio" | "video";
  urls: SideUrls;
  blobs: FileBlobs;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3 p-3">
      {SIDES.map((side) => {
        const url = urls[side];
        return url ? (
          <Player key={side} kind={kind} side={side} url={url} bytes={sideBytes(blobs, side)} />
        ) : null;
      })}
    </div>
  );
}

const SAMPLE = "The quick brown fox jumps over the lazy dog";
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 !?&@#%";

let fonts = 0;

/** A side's font, loaded under a name of its own and removed with the card. */
function useFontFace(url: string | null): { family: string } | { error: string } | null {
  const [state, setState] = useState<{
    url: string;
    value: { family: string } | { error: string };
  } | null>(null);
  useEffect(() => {
    if (!url) return;
    const family = `cr-preview-font-${++fonts}`;
    const face = new FontFace(family, `url(${JSON.stringify(url)})`);
    let live = true;
    face
      .load()
      .then(() => {
        // A card closed while its font loaded must not leave the font registered.
        if (!live) return undefined;
        document.fonts.add(face);
        setState({ url, value: { family } });
        return undefined;
      })
      .catch(() => {
        if (live) setState({ url, value: { error: "This browser could not read the font." } });
      });
    return () => {
      live = false;
      document.fonts.delete(face);
    };
  }, [url]);
  return url && state?.url === url ? state.value : null;
}

function FontSide({
  side,
  url,
  bytes,
}: {
  side: ComparisonSide;
  url: string;
  bytes: number | null;
}) {
  const face = useFontFace(url);
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <div className="min-h-24 rounded-md border border-border p-3">
        {face === null ? (
          <p className="text-[11px] text-muted-foreground">Loading the font…</p>
        ) : "error" in face ? (
          <p className="text-[11px] text-destructive-text">{face.error}</p>
        ) : (
          <div
            style={{ fontFamily: face.family }}
            className="flex flex-col gap-2 [overflow-wrap:anywhere]"
          >
            <p className="text-2xl leading-tight">{SAMPLE}</p>
            <p className="text-sm leading-snug">{GLYPHS}</p>
          </div>
        )}
      </div>
      <figcaption>
        <SideCaption side={side}>{bytes === null ? null : formatBytes(bytes)}</SideCaption>
      </figcaption>
    </figure>
  );
}

export function FontDiff({ urls, blobs }: { urls: SideUrls; blobs: FileBlobs }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3 p-3">
      {SIDES.map((side) => {
        const url = urls[side];
        return url ? (
          <FontSide key={side} side={side} url={url} bytes={sideBytes(blobs, side)} />
        ) : null;
      })}
    </div>
  );
}
