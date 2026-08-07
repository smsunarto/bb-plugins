// bb-plugin-ghostty — frontend entry.
//
// Renders BB terminal sessions with libghostty: ghostty-web wraps Ghostty's
// VT engine (libghostty-vt) compiled to WebAssembly behind an xterm.js-style
// API. The tab lives in the thread side panel next to BB's native "Start
// terminal" action; the PTY itself is a normal BB terminal session, so agents
// and the built-in terminal UI see the same shell.
import { useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc, useSettings } from "@bb/plugin-sdk/app";
import { FitAddon, Ghostty, Terminal, type ITheme } from "ghostty-web";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";

const WASM_URL = "/api/v1/plugins/ghostty/http/wasm";
const INITIAL_TAIL_BYTES = 262_144;
const POLL_ACTIVE_MS = 60;
const POLL_IDLE_MAX_MS = 500;

let ghosttyPromise: Promise<Ghostty> | null = null;
function loadGhostty(): Promise<Ghostty> {
  ghosttyPromise ??= Ghostty.load(WASM_URL);
  return ghosttyPromise;
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Resolve a host theme token to a concrete color the canvas renderer can use.
function cssVarColor(name: string, fallback: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name}, ${fallback})`;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color || fallback;
}

function withAlpha(color: string, alpha: number, fallback: string): string {
  const match = color.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!match) return fallback;
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
}

function hostTheme(): ITheme {
  const background = cssVarColor("--background", "#1d1f21");
  const foreground = cssVarColor("--foreground", "#c5c8c6");
  const accent = cssVarColor("--primary", "#5f87d7");
  return {
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: withAlpha(accent, 0.35, "rgba(95, 135, 215, 0.35)"),
    // Ghostty's default-ish 16-color palette; readable on light and dark.
    black: "#1d1f21",
    red: "#cc6666",
    green: "#b5bd68",
    yellow: "#f0c674",
    blue: "#81a2be",
    magenta: "#b294bb",
    cyan: "#8abeb7",
    white: "#c5c8c6",
    brightBlack: "#969896",
    brightRed: "#d54e53",
    brightGreen: "#b9ca4a",
    brightYellow: "#e7c547",
    brightBlue: "#7aa6da",
    brightMagenta: "#c397d8",
    brightCyan: "#70c0b1",
    brightWhite: "#eaeaea",
  };
}

type Phase = "loading" | "ready" | "exited" | "error";

function GhosttyPanel({ threadId }: { threadId: string; params: unknown }) {
  const rpc = useRpc<typeof rpcContract>();
  const { values, isLoading: settingsLoading } = useSettings();
  const settings: Record<string, unknown> = values ?? {};
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const restartRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (settingsLoading) return;
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let terminalId: string | null = null;
    let cursor: number | undefined;
    let idleDelay = POLL_ACTIVE_MS;
    let inputChain: Promise<unknown> = Promise.resolve();

    const fontSize = Number.parseInt(String(settings.fontSize ?? "13"), 10);
    const scrollback = Number.parseInt(
      String(settings.scrollback ?? "10000"),
      10,
    );

    function schedule(delay: number) {
      if (disposed) return;
      pollTimer = setTimeout(() => void poll(), delay);
    }

    async function poll() {
      if (disposed || !term || !terminalId) return;
      try {
        const res = await rpc.call("readOutput", {
          terminalId,
          ...(cursor === undefined
            ? { tailBytes: INITIAL_TAIL_BYTES }
            : { sinceSeq: cursor }),
        });
        if (disposed) return;
        if (cursor !== undefined && res.truncated) {
          // The server-side buffer rotated past our cursor: reset the screen
          // and re-sync from the tail instead of rendering a gap.
          term.write("\x1bc");
          cursor = undefined;
          schedule(0);
          return;
        }
        for (const chunk of res.chunks) {
          term.write(decodeBase64(chunk.dataBase64));
        }
        cursor = res.nextSeq;
        if (res.status === "exited") {
          setExitCode(res.exitCode);
          setPhase("exited");
          return;
        }
        if (res.chunks.length > 0) {
          idleDelay = POLL_ACTIVE_MS;
        } else {
          idleDelay = Math.min(idleDelay * 1.5, POLL_IDLE_MAX_MS);
        }
        schedule(idleDelay);
      } catch (err) {
        if (disposed) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    }

    restartRef.current = () => {
      if (disposed || !terminalId) return;
      void (async () => {
        try {
          const session = await rpc.call("restart", { terminalId });
          if (disposed || !term) return;
          terminalId = session.id;
          cursor = undefined;
          idleDelay = POLL_ACTIVE_MS;
          term.write("\x1bc");
          setExitCode(null);
          setPhase("ready");
          schedule(0);
        } catch (err) {
          if (disposed) return;
          setError(err instanceof Error ? err.message : String(err));
          setPhase("error");
        }
      })();
    };

    async function setup() {
      try {
        const ghostty = await loadGhostty();
        if (disposed) return;
        term = new Terminal({
          ghostty,
          theme: hostTheme(),
          fontFamily: String(
            settings.fontFamily ??
              '"JetBrains Mono", "SF Mono", Menlo, monospace',
          ),
          fontSize: Number.isFinite(fontSize) ? fontSize : 13,
          scrollback: Number.isFinite(scrollback) ? scrollback : 10000,
          cursorBlink: settings.cursorBlink !== false,
        });
        fit = new FitAddon();
        term.loadAddon(fit);
        term.open(container!);
        fit.fit();
        fit.observeResize();

        const session = await rpc.call("ensureTerminal", {
          threadId,
          cols: term.cols,
          rows: term.rows,
        });
        if (disposed) return;
        terminalId = session.id;

        term.onData((data) => {
          if (!terminalId) return;
          // Chain sends so keystrokes reach the PTY in order.
          inputChain = inputChain
            .then(() =>
              rpc.call("sendInput", {
                terminalId: terminalId!,
                dataBase64: encodeBase64(data),
              }),
            )
            .catch(() => {});
        });
        term.onResize(({ cols, rows }) => {
          if (!terminalId) return;
          void rpc.call("resize", { terminalId, cols, rows }).catch(() => {});
        });

        term.focus?.();
        setPhase(session.status === "exited" ? "exited" : "ready");
        setExitCode(session.exitCode);
        if (session.status !== "exited") schedule(0);
      } catch (err) {
        if (disposed) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    }

    void setup();

    return () => {
      disposed = true;
      restartRef.current = null;
      if (pollTimer) clearTimeout(pollTimer);
      fit?.dispose();
      term?.dispose();
      container.replaceChildren();
    };
    // Re-run only on retry; settings apply on next mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, attempt, settingsLoading]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <div ref={containerRef} className="h-full w-full" />
      {phase === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Loading libghostty…
        </div>
      )}
      {phase === "exited" && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80">
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-6">
            <span className="text-sm text-muted-foreground">
              Session exited
              {exitCode !== null ? ` (code ${exitCode})` : ""}
            </span>
            <Button size="sm" onClick={() => restartRef.current?.()}>
              Start new shell
            </Button>
          </div>
        </div>
      )}
      {phase === "error" && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80">
          <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-border bg-card p-6">
            <span className="text-sm text-destructive">
              Terminal error: {error}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setError(null);
                setPhase("loading");
                setAttempt((n) => n + 1);
              }}
            >
              Retry
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "ghostty-terminal",
    title: "Ghostty terminal",
    layout: "flush",
    component: GhosttyPanel,
  });
});
