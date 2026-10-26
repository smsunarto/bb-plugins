import {
  experimental_ImageLightbox as ImageLightbox,
  experimental_usePluginId,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  htmlRenderFrameHeight,
  htmlRenderPagePath,
  htmlRenderResult,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderImageRequest,
  readHtmlRenderLinkRequest,
} from "../shared/html-render.ts";
import type { HtmlRenderReference } from "../shared/html-render.ts";
import { observeBbTheme, readBbTheme } from "./theme.ts";

const SANDBOX = "allow-scripts allow-forms allow-popups allow-downloads";
const HEIGHT_KEY = "bb-html:height:";

/** The last height a page reported, so a remount reserves the right space at once. */
function cachedHeight(id: string): number | undefined {
  try {
    const value = Number(localStorage.getItem(HEIGHT_KEY + id));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function cacheHeight(id: string, height: number) {
  try {
    localStorage.setItem(HEIGHT_KEY + id, String(Math.ceil(height)));
  } catch {
    // Storage can be full or unavailable; the frame still fits the live page.
  }
}

export function pageUrl(pluginId: string, id: string): string {
  return `/api/v1/plugins/${encodeURIComponent(pluginId)}/http${htmlRenderPagePath(id)}`;
}

export function HtmlRenderFrame({ reference }: { reference: HtmlRenderReference }) {
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(() => cachedHeight(reference.id));
  const [image, setImage] = useState<{ src: string; name: string } | null>(null);
  // The frame keeps the theme it loaded with; later changes arrive as messages.
  const [src] = useState(
    () => `${pageUrl(pluginId, reference.id)}${htmlRenderThemeFragment(readBbTheme())}`,
  );

  const onMessage = useEffectEvent((event: MessageEvent) => {
    // The page's own scripts can post anything, so trust only this frame and parse every field.
    if (event.source === null || event.source !== frame.current?.contentWindow) return;
    const height = readHtmlRenderContentHeight(event.data);
    if (height !== undefined) {
      setContentHeight(height);
      cacheHeight(reference.id, height);
      return;
    }
    // Links and images open only from a click in this frame, never from a page script alone.
    const clicked =
      document.activeElement === frame.current && navigator.userActivation?.isActive !== false;
    if (!clicked) return;
    const link = readHtmlRenderLinkRequest(event.data);
    if (link) {
      navigate.openUrl(link.url);
      event.source.postMessage(htmlRenderResult(link.id), { targetOrigin: "*" });
      return;
    }
    const request = readHtmlRenderImageRequest(event.data);
    if (request) setImage(request);
  });

  useEffect(() => {
    const receive = (event: MessageEvent) => onMessage(event);
    window.addEventListener("message", receive);
    const stop = observeBbTheme((theme) =>
      frame.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*"),
    );
    return () => {
      window.removeEventListener("message", receive);
      stop();
    };
  }, []);

  const height = htmlRenderFrameHeight(reference.height, contentHeight);
  const fullScreen = () => {
    const element = box.current;
    if (element?.requestFullscreen && document.fullscreenEnabled) {
      void element
        .requestFullscreen()
        .catch(() => navigate.openUrl(new URL(src, location.href).href));
    } else {
      navigate.openUrl(new URL(src, location.href).href);
    }
  };

  return (
    <div ref={box} className="bb-html-render" style={{ height }}>
      <iframe
        ref={frame}
        className="bb-html-render-frame"
        src={src}
        title={reference.title}
        sandbox={SANDBOX}
        referrerPolicy="no-referrer"
        loading="lazy"
        // The URL's theme is the one at mount; a lazy or slow load may land after bb switched.
        onLoad={() =>
          frame.current?.contentWindow?.postMessage(htmlRenderThemeMessage(readBbTheme()), "*")
        }
      />
      <div className="bb-html-render-actions">
        <button
          type="button"
          className="bb-html-render-button"
          aria-label="Open full screen"
          title="Open full screen"
          onClick={fullScreen}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>
      </div>
      {image ? (
        <ImageLightbox
          isOpen
          imageSrc={image.src}
          imageAlt={image.name}
          title={image.name}
          onClose={() => setImage(null)}
        />
      ) : null}
    </div>
  );
}
