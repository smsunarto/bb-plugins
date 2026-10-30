import { experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import { persistedStore } from "../reservedHeight";
import { createElement, useEffect, useRef, useState, type CSSProperties } from "react";
import { useUiRuntime } from "../runtime";
import { optionalText, text, type Props } from "../values";
import { ErrorLine } from "./display";
import { useHeightHold, useImageUrl } from "./media";

type Playback =
  | { status: "loading" }
  | { status: "ready"; url: string; expiresAtMs: number | null }
  | { status: "failed"; error: string };

const playerLoads = new Map<string, Promise<boolean>>();
const sizes = persistedStore("bb.genui.videoSizes", 200);
/** The module is a separate server asset: BB's app builder does not split imports. */
function loadPlayer(pluginId: string): Promise<boolean> {
  const url = `/api/v1/plugins/${encodeURIComponent(pluginId)}/http/video-player.js`;
  const cached = playerLoads.get(url);
  if (cached) return cached;
  const pending = import(/* @vite-ignore */ url).then(
    () => Boolean(customElements.get("video-player") && customElements.get("video-skin")),
    () => {
      playerLoads.delete(url);
      return false;
    },
  );
  playerLoads.set(url, pending);
  return pending;
}

const PLAYER_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  minWidth: 0,
};
const SKIN_STYLE = {
  ...PLAYER_STYLE,
  "--media-border-radius": "var(--radius-lg, 0.5rem)",
  "--media-font-family": "var(--font-sans)",
};

export function Video({ props }: { props: Props }) {
  const src = text(props.src).trim();
  const { threadId } = useUiRuntime();
  const [retry, setRetry] = useState(0);
  // Reset decoding, error and playback state together when the requested file changes.
  return (
    <VideoFile
      key={`${threadId ?? "gallery"}|${src}|${retry}`}
      onRetry={() => setRetry((value) => value + 1)}
      src={src}
      poster={optionalText(props.poster)?.trim() || null}
      caption={optionalText(props.caption)?.trim() || null}
    />
  );
}

function VideoFile({
  src,
  poster,
  caption,
  onRetry,
}: {
  src: string;
  poster: string | null;
  caption: string | null;
  onRetry: () => void;
}) {
  const { loadVideo, threadId } = useUiRuntime();
  const pluginId = experimental_usePluginId();
  const sizeKey = JSON.stringify([threadId, src]);
  const [size, setSize] = useState(() => sizes.store().entry(sizeKey));
  const [renewal, setRenewal] = useState(0);
  const [playback, setPlayback] = useState<Playback>({ status: "loading" });
  const [enhanced, setEnhanced] = useState(false);
  const consecutiveFailures = useRef(0);
  const resume = useRef<{ time: number; playing: boolean } | null>(null);
  const image = useImageUrl(poster);

  useEffect(() => {
    let active = true;
    void loadPlayer(pluginId).then((ready) => {
      if (active) setEnhanced(ready);
      return ready;
    });
    return () => {
      active = false;
    };
  }, [pluginId]);

  useEffect(() => {
    let active = true;
    let ownedUrl: string | null = null;
    const read = async () => {
      if (!src || (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src))) {
        setPlayback({
          status: "failed",
          error:
            "Video needs a local file path. Download remote clips into $BB_THREAD_STORAGE first.",
        });
        return;
      }
      if (loadVideo === null) {
        setPlayback({ status: "failed", error: "Videos can't be loaded on this surface." });
        return;
      }
      try {
        const result = await loadVideo(src, renewal > 0);
        if (!active) {
          if (result.ok && result.owned) URL.revokeObjectURL(result.url);
          return;
        }
        if (!result.ok) {
          setPlayback({ status: "failed", error: result.error });
          return;
        }
        ownedUrl = result.owned ? result.url : null;
        setPlayback({ status: "ready", url: result.url, expiresAtMs: result.expiresAtMs });
      } catch (cause) {
        if (active)
          setPlayback({
            status: "failed",
            error: cause instanceof Error ? cause.message : String(cause),
          });
      }
    };
    void read();
    return () => {
      active = false;
      if (ownedUrl !== null) URL.revokeObjectURL(ownedUrl);
    };
  }, [src, loadVideo, renewal]);

  useHeightHold(playback.status === "loading");

  if (playback.status === "failed")
    return (
      <div className="space-y-2">
        <ErrorLine message={`Couldn't show ${src}: ${playback.error}`} />
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted focus-visible:outline focus-visible:outline-ring"
        >
          Retry video
        </button>
      </div>
    );

  return (
    <figure className="m-0 min-w-0 space-y-2">
      {playback.status === "loading" ? (
        <output
          style={{ aspectRatio: size === null ? "16 / 9" : `${size[0]} / ${size[1]}` }}
          className="flex max-h-[32rem] items-center justify-center rounded-lg bg-surface-recessed text-sm text-muted-foreground"
        >
          Loading video…
        </output>
      ) : (
        createElement(
          "video-player",
          { style: PLAYER_STYLE },
          createElement(
            "video-skin",
            { style: SKIN_STYLE },
            // Recordings may be silent; never invent a timed captions track.
            // oxlint-disable-next-line jsx-a11y/media-has-caption
            <video
              key={playback.url}
              src={playback.url}
              poster={image.status === "ready" ? image.url : undefined}
              aria-label={caption ?? "Video recording"}
              controls={!enhanced}
              playsInline
              preload="metadata"
              className="block max-h-[32rem] w-full rounded-lg bg-surface-recessed object-contain"
              onCanPlay={() => {
                consecutiveFailures.current = 0;
              }}
              onLoadedMetadata={(event) => {
                const pending = resume.current;
                if (pending !== null) {
                  resume.current = null;
                  const video = event.currentTarget;
                  video.currentTime = Math.min(
                    pending.time,
                    Number.isFinite(video.duration) ? video.duration : pending.time,
                  );
                  if (pending.playing) void video.play().catch(() => undefined);
                }
                const { videoWidth, videoHeight } = event.currentTarget;
                if (videoWidth > 0 && videoHeight > 0) {
                  sizes.store().set(sizeKey, videoWidth, videoHeight);
                  sizes.save();
                  setSize([videoWidth, videoHeight]);
                }
              }}
              onError={(event) => {
                const video = event.currentTarget;
                const expired = playback.expiresAtMs !== null && playback.expiresAtMs <= Date.now();
                const decodeFailed = video.error?.code === 3; // MEDIA_ERR_DECODE
                if (
                  playback.expiresAtMs !== null &&
                  !decodeFailed &&
                  consecutiveFailures.current < 1
                ) {
                  consecutiveFailures.current += 1;
                  resume.current = { time: video.currentTime, playing: !video.paused };
                  setRenewal((value) => value + 1);
                  setPlayback({ status: "loading" });
                } else {
                  setPlayback({
                    status: "failed",
                    error: expired && !decodeFailed
                      ? "The playback link expired and could not be renewed. Retry when the host is available."
                      : "The recording could not be loaded or decoded. Check the host connection and file; H.264 MP4 is recommended.",
                  });
                }
              }}
            />,
          ),
        )
      )}
      {caption === null ? null : (
        <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
      )}
      {poster !== null && image.status === "failed" ? (
        <ErrorLine message={`Couldn't show the poster: ${image.error}`} />
      ) : null}
    </figure>
  );
}
