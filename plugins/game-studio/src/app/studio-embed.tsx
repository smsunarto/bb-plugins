import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import { studioRequests, type StudioPromptInput } from "./studio-requests.ts";

/*
 * The studio web app in an iframe. The page introduces itself with `game-studio:hello`; this
 * side answers `game-studio:host` with what bb offers, and takes the requests the page then
 * posts for the composer. Cloudflare Access signs the person in with a cookie on the studio's
 * origin, which a browser may withhold from a frame: the bar always offers the studio in a tab.
 */

/** How long a frame may stay silent before the sign-in hint shows. */
const HELLO_WAIT_MS = 8_000;

type InsertRequest = {
  type: "game-studio:insert-request";
  prompt: string;
  request: unknown;
  input: StudioPromptInput;
};
const isHello = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  (data as { type?: unknown }).type === "game-studio:hello" &&
  (data as { version?: unknown }).version === 1;
function isInsertRequest(data: unknown): data is InsertRequest {
  if (typeof data !== "object" || data === null) return false;
  const message = data as Partial<InsertRequest>;
  return (
    message.type === "game-studio:insert-request" &&
    typeof message.prompt === "string" &&
    typeof message.input === "object" &&
    message.input !== null &&
    typeof message.input.gameId === "string" &&
    typeof message.input.action === "string"
  );
}

/** The studio page for a game, or its gallery, as the panel opens it. */
export function studioPageUrl(studioUrl: string, gameId: string | null) {
  const base = studioUrl.replace(/\/+$/, "");
  return gameId ? `${base}/games/${encodeURIComponent(gameId)}?embed=1` : `${base}/?embed=1`;
}

export function StudioEmbed({
  studioUrl,
  gameId,
  threadId,
  composer,
  title,
}: {
  studioUrl: string;
  gameId: string | null;
  /** The thread whose composer takes requests; null on the new-thread panel. */
  threadId: string | null;
  /** Whether a composer is beside the frame to carry its requests. */
  composer: boolean;
  title: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [connected, setConnected] = useState(false);
  const [quiet, setQuiet] = useState(false);
  // The frame keeps its own navigation; the parent keys this component by studio and game, so a
  // new game or a new studio URL remounts it with a new page.
  const [src] = useState(() => studioPageUrl(studioUrl, gameId));
  const origin = new URL(src).origin;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const window = frame.current?.contentWindow;
      if (!window || event.source !== window || event.origin !== origin) return;
      if (isHello(event.data)) {
        setConnected(true);
        window.postMessage(
          { type: "game-studio:host", version: 1, capabilities: { composer } },
          origin,
        );
      } else if (isInsertRequest(event.data) && composer) {
        const { prompt, request, input } = event.data;
        studioRequests.post({ threadId, prompt, request, input });
      }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [origin, composer, threadId]);
  useEffect(() => {
    if (connected) return;
    const timer = setTimeout(() => setQuiet(true), HELLO_WAIT_MS);
    return () => clearTimeout(timer);
  }, [connected]);
  const opened = src.replace(/\?embed=1$/, "");
  return (
    <div className="gs-app gs-embed">
      <div className="gs-embed-bar">
        <Icon name="Joystick" />
        <strong className="gs-truncate" title={title}>
          {title}
        </strong>
        <span className="gs-spacer" />
        <span className="gs-embed-status" data-connected={connected}>
          <span className="gs-status-dot" />
          {connected ? (composer ? "Linked to this chat" : "Connected") : "Loading…"}
        </span>
        <a href={opened} target="_blank" rel="noreferrer" title="Open the studio in a new tab">
          <Icon name="ExternalLink" />
          Open
        </a>
      </div>
      {quiet && !connected && (
        <p className="gs-embed-hint">
          The studio has not answered. If it shows a sign-in page or stays blank, your browser may
          be keeping its sign-in cookie out of this frame:{" "}
          <a href={opened} target="_blank" rel="noreferrer">
            open the studio in a tab
          </a>
          , sign in there, then reopen this panel.
        </p>
      )}
      {/* Another origin: the frame keeps its own cookies and scripts, as any cross-site page does. */}
      {/* oxlint-disable-next-line react/iframe-missing-sandbox -- a sandbox would withhold the sign-in cookie */}
      <iframe ref={frame} src={src} title={title} allow="clipboard-write" />
    </div>
  );
}
