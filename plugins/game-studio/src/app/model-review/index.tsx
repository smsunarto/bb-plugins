import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import {
  animationTime,
  cameras,
  modeAvailability,
  parseShotScript,
  reviewModes,
  shotSchema,
  type CameraPreset,
  type ReviewMode,
} from "../../shared/model-review.ts";
import { rpc } from "../rpc.ts";
import { captureShots, type CaptureResult } from "./capture.ts";
import { ReviewEngine, type ModelStats, type View } from "./engine.ts";
import "./review.css";

const ReviewGame = createContext("");
export function ModelReviewLinks({ gameId, children }: { gameId: string; children: ReactNode }) {
  return <ReviewGame.Provider value={gameId}>{children}</ReviewGame.Provider>;
}
const waiting = new Map<symbol, { callback: (allowed: boolean) => void; priority: number }>();
function allocatePreviews() {
  let slots = 4;
  for (const { callback } of [...waiting.values()].sort((a, b) => b.priority - a.priority))
    callback(slots-- > 0);
}
export function ModelPreview({
  url,
  name,
  path,
  showOpen = true,
}: {
  url: string;
  name: string;
  path?: string;
  showOpen?: boolean;
}) {
  const host = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [admitted, setAdmitted] = useState(false);
  const [state, setState] = useState("Loading model…");
  const gameId = useContext(ReviewGame);
  const navigate = useBbNavigate();
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "100px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) {
      setAdmitted(false);
      return;
    }
    const id = Symbol();
    waiting.set(id, { callback: setAdmitted, priority: showOpen ? 1 : 0 });
    allocatePreviews();
    return () => {
      waiting.delete(id);
      allocatePreviews();
    };
  }, [visible, showOpen]);
  useEffect(() => {
    if (!admitted || !host.current) return;
    let engine: ReviewEngine | undefined;
    let live = true;
    setState("Loading model…");
    try {
      engine = new ReviewEngine(host.current);
      void engine
        .load(url)
        .then(() => {
          if (live) setState("");
          return undefined;
        })
        .catch((error) => {
          if (live) setState(error instanceof Error ? error.message : "Could not load model");
        });
    } catch (error) {
      setState(error instanceof Error ? error.message : "WebGL unavailable");
    }
    return () => {
      live = false;
      engine?.dispose();
    };
  }, [admitted, url]);
  return (
    <figure
      ref={host}
      className="gs-model-preview gs-review-preview nodrag"
      data-state={state ? "loading" : "ready"}
      aria-label={`3D preview of ${name}. Drag to orbit.`}
    >
      {(!admitted || state) && <span>{admitted ? state : "3D preview paused"}</span>}
      {showOpen && path && gameId && (
        <button
          className="gs-open-model nodrag"
          onClick={(event) => {
            event.stopPropagation();
            // BB escapes each subPath segment; project paths stay raw here.
            navigate.toPluginPanel("studio", {
              subPath: `${gameId}/viewer/${path}`,
            });
          }}
        >
          Open in viewer ↗
        </button>
      )}
    </figure>
  );
}
const exampleScript = {
  width: 1280,
  height: 720,
  shots: [
    { name: "topology", mode: "wireframe", camera: "front" },
    {
      name: "turntable",
      mode: "shaded",
      camera: "three-quarter",
      video: { duration: 3, fps: 24, turntable: true },
    },
  ],
};
type Harness = {
  stats: ModelStats;
  capture: (script: unknown) => Promise<CaptureResult>;
  view: (shot: unknown) => void;
};
declare global {
  interface Window {
    gameStudioModelReview?: Harness;
  }
}
const causeMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function ModelReviewPage({ gameId, path }: { gameId: string; path: string }) {
  const preview = rpc.preview.useQuery(
    { gameId },
    { staleTime: 45 * 60_000, refetchInterval: 45 * 60_000 },
  );
  const game = rpc.get.useQuery({ gameId }, { retry: false });
  const navigate = useBbNavigate();
  const url = preview.data
    ? `${preview.data.baseUrl.replace(/\/$/, "")}/${path.split("/").map(encodeURIComponent).join("/")}`
    : "";
  // The game record only names the header; a model can be reviewed without it.
  if (preview.error)
    return (
      <main className="gs-app">
        <p role="alert">{preview.error.message}</p>
      </main>
    );
  return (
    <main className="gs-app gs-model-review-page">
      <header className="gs-review-header">
        <button onClick={() => navigate.toPluginPanel("studio", { subPath: gameId })}>
          ← Studio
        </button>
        <div>
          <h1>{path.split("/").pop()}</h1>
          <small>
            {game.data?.game.name ?? "Model review"} · {path}
          </small>
        </div>
        <span className="gs-muted">Drag to orbit · Wheel to zoom · Right-drag to pan</span>
      </header>
      {url ? (
        // A refreshed lease must not reload a model that is already open, or abort its capture.
        <FullViewer key={`${gameId}:${path}`} gameId={gameId} path={path} leasedUrl={url} />
      ) : (
        <output>Opening model…</output>
      )}
    </main>
  );
}
function FullViewer({
  gameId,
  path,
  leasedUrl,
}: {
  gameId: string;
  path: string;
  leasedUrl: string;
}) {
  // The model is read once; later leases only matter to a later viewer.
  const [url] = useState(leasedUrl);
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<ReviewEngine | null>(null);
  const [stats, setStats] = useState<ModelStats | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Loading model…");
  const [mode, setMode] = useState<ReviewMode>("shaded");
  const [camera, setCamera] = useState<CameraPreset>("three-quarter");
  const [joint, setJoint] = useState(0);
  const [clip, setClip] = useState("");
  const [time, setTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const playheadRef = useRef(0);
  const playingRef = useRef(false);
  playingRef.current = playing;
  const [turntable, setTurntable] = useState(false);
  const [code, setCode] = useState(false);
  const [script, setScript] = useState(JSON.stringify(exampleScript, null, 2));
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const captureController = useRef<AbortController | null>(null);
  const life = useRef(true);
  const client = rpc.useClient();
  const currentView = useRef<View>({ mode });
  const previousCamera = useRef<CameraPreset>("three-quarter");
  currentView.current = {
    mode,
    camera,
    joint,
    ...(clip ? { animation: { clip, time, speed, loop } } : {}),
  };
  useEffect(() => {
    life.current = true;
    if (!host.current) return;
    let loaded: ReviewEngine;
    try {
      loaded = new ReviewEngine(host.current, true);
      engine.current = loaded;
    } catch (error) {
      setError(causeMessage(error));
      setStatus("");
      return;
    }
    void loaded
      .load(url)
      .then((loadedStats) => {
        if (life.current && loadedStats) {
          setStats({ ...loadedStats });
          setStatus("");
        }
        return undefined;
      })
      .catch((error) => {
        if (life.current) {
          setError(causeMessage(error));
          setStatus("");
        }
      });
    return () => {
      life.current = false;
      captureController.current?.abort();
      loaded.dispose();
      engine.current = null;
    };
  }, [url]);
  useEffect(() => {
    if (!stats || lock.current) return;
    try {
      const pose = previousCamera.current === camera ? engine.current?.cameraPose() : undefined;
      engine.current?.view({ ...currentView.current, ...(pose ? { orbit: pose } : {}) });
      previousCamera.current = camera;
      setError("");
    } catch (error) {
      setError(causeMessage(error));
    }
  }, [mode, camera, joint, clip, time, speed, loop, stats]);
  useEffect(() => {
    if (!stats || busy || (!playing && !turntable)) return;
    let frame = 0;
    let lastUiUpdate = 0;
    let start: number | undefined;
    const tick = (now: number) => {
      start ??= now;
      const elapsed = (now - start) / 1000;
      engine.current?.renderAt(playing ? elapsed : 0, turntable ? (elapsed * Math.PI) / 5 : 0);
      if (playing && clip) {
        const duration = stats.clips.find((item) => item.name === clip)!.duration;
        playheadRef.current = animationTime(time + elapsed * speed, duration, loop);
        if (now - lastUiUpdate > 100) {
          setPlayhead(playheadRef.current);
          lastUiUpdate = now;
        }
        if (!loop && playheadRef.current >= duration) {
          setTime(duration);
          setPlaying(false);
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [stats, busy, playing, turntable, mode, camera, joint, clip, time, speed, loop]);
  const capture = useCallback(
    async (raw: unknown) => {
      if (lock.current || !engine.current || !stats)
        throw new Error("Viewer is not ready or is already capturing");
      let parsed: ReturnType<typeof parseShotScript>;
      try {
        parsed = parseShotScript(raw);
      } catch (error) {
        setError(causeMessage(error));
        setStatus("");
        throw error;
      }
      lock.current = true;
      setBusy(true);
      setError("");
      // Playback advances only the playhead; pause there so the capture returns to that pose.
      if (playingRef.current && currentView.current.animation) {
        currentView.current.animation.time = playheadRef.current;
        setTime(playheadRef.current);
      }
      setPlaying(false);
      setTurntable(false);
      setResult(null);
      const controller = new AbortController();
      captureController.current = controller;
      const renderer = engine.current;
      const restoreView = { ...currentView.current, orbit: renderer.cameraPose() };
      try {
        const captured = await captureShots(
          renderer,
          parsed,
          path,
          gameId,
          (input) => client.modelEvidence(input),
          (value) => {
            if (life.current) setStatus(value);
          },
          controller.signal,
        );
        if (life.current) setResult(captured);
        return captured;
      } catch (error) {
        if (life.current) {
          setError(causeMessage(error));
          setStatus("");
        }
        throw error;
      } finally {
        lock.current = false;
        if (life.current) {
          setBusy(false);
          try {
            renderer.view(restoreView);
          } catch {
            /* Original view was valid before capture. */
          }
        }
      }
    },
    [stats, path, gameId, client],
  );
  useEffect(() => {
    if (!stats) return;
    const harness: Harness = {
      stats,
      capture,
      view: (raw) => {
        if (lock.current) throw new Error("A capture is running");
        const shot = shotSchema.parse(raw);
        engine.current?.view(shot);
        // The view effect keeps this pose rather than re-applying the camera preset.
        previousCamera.current = shot.camera;
        setMode(shot.mode);
        setCamera(shot.camera);
        setJoint(shot.joint);
        setClip(shot.animation?.clip ?? "");
        setTime(shot.animation?.time ?? 0);
        setSpeed(shot.animation?.speed ?? 1);
        setLoop(shot.animation?.loop ?? true);
      },
    };
    window.gameStudioModelReview = harness;
    return () => {
      if (window.gameStudioModelReview === harness) delete window.gameStudioModelReview;
    };
  }, [stats, capture]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        busy ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      )
        return;
      const selected =
        stats &&
        modeAvailability(stats.facts).find((item) => "key" in item && item.key === event.key);
      if (selected && !selected.reason) {
        event.preventDefault();
        setMode(selected.id);
      }
      if (event.code === "Space" && clip) {
        event.preventDefault();
        setPlaying((value) => {
          if (value) setTime(playheadRef.current);
          return !value;
        });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [stats, busy, clip]);
  const shoot = (video = false) => {
    const shot = {
      name: video ? "turntable" : mode,
      ...currentView.current,
      orbit: engine.current?.cameraPose(),
      ...(playing && clip ? { animation: { clip, time: playheadRef.current, speed, loop } } : {}),
      ...(video ? { video: { duration: 3, fps: 24, turntable: true } } : {}),
    };
    void capture({ width: 1280, height: 720, shots: [shot] }).catch(() => {});
  };
  const duration = stats?.clips.find((item) => item.name === clip)?.duration ?? 0;
  return (
    <div className="gs-review-layout">
      <section className="gs-review-workspace">
        <div className="gs-review-toolbar">
          <label>
            Camera{" "}
            <select
              disabled={!stats || busy}
              value={camera}
              onChange={(event) => setCamera(event.target.value as CameraPreset)}
            >
              {cameras.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <button
            disabled={!stats || busy}
            aria-pressed={turntable}
            onClick={() => setTurntable((value) => !value)}
          >
            Turntable
          </button>
          <span className="gs-spacer" />
          <button disabled={!stats || busy} onClick={() => shoot()}>
            Screenshot
          </button>
          <button disabled={!stats || busy} onClick={() => shoot(true)}>
            Record turntable
          </button>
          <button aria-pressed={code} onClick={() => setCode((value) => !value)}>
            Code
          </button>
        </div>
        <div
          ref={host}
          className="gs-review-stage"
          aria-label="3D model review viewport"
          data-ready={!!stats}
        />
        {error && (
          <p className="gs-review-error" role="alert">
            {error}
          </p>
        )}
        <output className="gs-review-status">
          {status ||
            (stats
              ? `${stats.triangles.toLocaleString()} triangles · ${stats.vertices.toLocaleString()} vertices · +Z forward`
              : "Loading model…")}
          {busy && (
            <button onClick={() => captureController.current?.abort()}>Cancel capture</button>
          )}
        </output>
        {result && (
          <p className="gs-review-saved">
            Saved to Evidence: <code>{`canvas/evidence/${result.runId}/`}</code>
            <br />
            {result.files.map((file) => (
              <span key={file}>{file.split("/").pop()} </span>
            ))}
          </p>
        )}
        {code && (
          <section className="gs-review-code">
            <label htmlFor="gs-shot-script">Shot script · fixed timesteps · PNG + MP4</label>
            <textarea
              id="gs-shot-script"
              spellCheck={false}
              disabled={busy}
              value={script}
              onChange={(event) => setScript(event.target.value)}
            />
            <button disabled={!stats || busy} onClick={() => void capture(script).catch(() => {})}>
              Run shot script
            </button>
            <small>Agent API: await window.gameStudioModelReview.capture(script)</small>
          </section>
        )}
      </section>
      <aside className="gs-review-sidebar">
        <h2>Review modes</h2>
        <div className="gs-review-modes">
          {(stats
            ? modeAvailability(stats.facts)
            : reviewModes.map((item) => Object.assign({}, item, { reason: "Loading model" }))
          ).map((item) => (
            <button
              key={item.id}
              title={item.reason ?? item.label}
              disabled={!!item.reason || busy}
              aria-pressed={item.id === mode}
              onClick={() => setMode(item.id)}
            >
              <span>{item.label}</span>
              <small>{item.reason ?? ("key" in item ? item.key : "")}</small>
            </button>
          ))}
        </div>
        {mode === "weights" && stats && (
          <label>
            Joint
            <select
              value={joint}
              disabled={busy}
              onChange={(event) => setJoint(Number(event.target.value))}
            >
              {stats.joints.map((name, index) => (
                <option key={name} value={index}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        <h2>Animation</h2>
        {stats?.clips.length ? (
          <fieldset disabled={busy} className="gs-review-animation">
            <label>
              Clip
              <select
                value={clip}
                onChange={(event) => {
                  setClip(event.target.value);
                  setTime(0);
                  setPlaying(false);
                }}
              >
                <option value="">Bind pose</option>
                {stats.clips.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name} · {item.duration.toFixed(2)}s
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={!clip}
              aria-pressed={playing}
              onClick={() => {
                if (playing) setTime(playheadRef.current);
                setPlaying(!playing);
              }}
            >
              {playing ? "Pause" : "Play"} · Space
            </button>
            <label>
              Time {(playing ? playhead : time).toFixed(2)}s
              <input
                aria-label="Animation time"
                type="range"
                min={0}
                max={duration}
                step={0.01}
                value={playing ? playhead : time}
                disabled={!clip}
                onChange={(event) => {
                  setPlaying(false);
                  setTime(Number(event.target.value));
                }}
              />
            </label>
            <label>
              Speed
              <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                {[0.25, 0.5, 1, 2, 4].map((value) => (
                  <option key={value} value={value}>
                    {value}×
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={loop}
                onChange={(event) => setLoop(event.target.checked)}
              />
              Loop
            </label>
          </fieldset>
        ) : (
          <p className="gs-muted">No animation clips</p>
        )}
        {stats && (
          <>
            <h2>Model stats</h2>
            <dl className="gs-review-stats">
              <dt>Triangles</dt>
              <dd>{stats.triangles.toLocaleString()}</dd>
              <dt>Vertices</dt>
              <dd>{stats.vertices.toLocaleString()}</dd>
              <dt>Meshes / materials</dt>
              <dd>
                {stats.meshes} / {stats.materials}
              </dd>
              <dt>Joints / clips</dt>
              <dd>
                {stats.joints.length} / {stats.clips.length}
              </dd>
              <dt>Size XYZ (m)</dt>
              <dd>{stats.dimensions.map((value) => value.toFixed(3)).join(" × ")}</dd>
            </dl>
            <h3>Textures · {stats.textures.length}</h3>
            {stats.textures.map((item) => (
              <p className="gs-review-texture" key={item.id}>
                {item.name}
                <small>
                  {item.width} × {item.height}
                </small>
              </p>
            ))}
          </>
        )}
      </aside>
    </div>
  );
}
