import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import {
  animationTime,
  modeAvailability,
  modeGroups,
  parseShotScript,
  reviewModes,
  rulerTicks,
  shotSchema,
  type CameraPreset,
  type ReviewMode,
} from "../../shared/model-review.ts";
import { Icon } from "../icons.tsx";
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
          <Icon name="Maximize2" />
          Open in viewer
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
/** Toolbar order and labels; the record type makes a new preset in `cameras` fail to compile here. */
const cameraLabels: Record<CameraPreset, string> = {
  "three-quarter": "¾",
  front: "Front",
  back: "Back",
  left: "Left",
  right: "Right",
  top: "Top",
};
const cameraPresets = Object.entries(cameraLabels) as [CameraPreset, string][];
/** What a false-colour mode's dark and bright ends mean. */
const legends: Partial<Record<ReviewMode, { low: string; high: string; scale: "grey" | "heat" }>> =
  {
    metallic: { low: "Dielectric", high: "Metal", scale: "grey" },
    roughness: { low: "Smooth", high: "Rough", scale: "grey" },
    occlusion: { low: "Occluded", high: "Open", scale: "grey" },
    weights: { low: "No influence", high: "Full", scale: "heat" },
  };
const speeds = [0.25, 0.5, 1, 2, 4];
function TextureThumb({ id, engine }: { id: string; engine: RefObject<ReviewEngine | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(true);
  useEffect(() => {
    if (canvas.current) setDrawn(engine.current?.drawTexture(id, canvas.current) ?? false);
  }, [id, engine]);
  return <canvas ref={canvas} width={64} height={64} data-empty={!drawn} aria-hidden />;
}
function counted(value: number, one: string, many = `${one}s`) {
  return (
    <>
      <strong>{value.toLocaleString()}</strong> {value === 1 ? one : many}
    </>
  );
}
export function ModelReviewPage({ gameId, path }: { gameId: string; path: string }) {
  const preview = rpc.preview.useQuery(
    { gameId },
    { staleTime: 45 * 60_000, refetchInterval: 45 * 60_000 },
  );
  const game = rpc.get.useQuery({ gameId }, { retry: false });
  const [loaded, setLoaded] = useState<{ model: string; stats: ModelStats } | null>(null);
  const stats = loaded?.model === `${gameId}:${path}` ? loaded.stats : null;
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
        <button
          className="gs-review-back"
          onClick={() => navigate.toPluginPanel("studio", { subPath: gameId })}
        >
          <Icon name="ArrowLeft" />
          Studio
        </button>
        <div className="gs-review-title">
          <h1>{path.split("/").pop()}</h1>
          <small>
            {game.data ? `${game.data.game.name} · ` : ""}
            <code>{path}</code>
          </small>
        </div>
        {stats && (
          <ul className="gs-review-facts" aria-label="Model stats">
            <li>{counted(stats.triangles, "triangle")}</li>
            <li>{counted(stats.vertices, "vertex", "vertices")}</li>
            <li>
              {counted(stats.meshes, "mesh", "meshes")} · {counted(stats.materials, "material")}
            </li>
            <li>{counted(stats.joints.length, "joint")}</li>
            <li>{counted(stats.clips.length, "clip")}</li>
            <li>
              <strong>{stats.dimensions.map((value) => value.toFixed(2)).join(" × ")}</strong> m ·
              +Z forward
            </li>
          </ul>
        )}
      </header>
      {url ? (
        // A refreshed lease must not reload a model that is already open, or abort its capture.
        <FullViewer
          key={`${gameId}:${path}`}
          gameId={gameId}
          path={path}
          leasedUrl={url}
          onLoad={(stats) => setLoaded({ model: `${gameId}:${path}`, stats })}
        />
      ) : (
        <div className="gs-review-center">
          <Icon name="LoaderCircle" className="gs-review-spin" />
          Opening model…
        </div>
      )}
    </main>
  );
}
function FullViewer({
  gameId,
  path,
  leasedUrl,
  onLoad,
}: {
  gameId: string;
  path: string;
  leasedUrl: string;
  onLoad: (stats: ModelStats) => void;
}) {
  // The model is read once; later leases only matter to a later viewer.
  const [url] = useState(leasedUrl);
  // The page's callback changes each render; loading must still run once per model.
  const reportLoad = useRef(onLoad);
  reportLoad.current = onLoad;
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<ReviewEngine | null>(null);
  const [stats, setStats] = useState<ModelStats | null>(null);
  const [error, setError] = useState("");
  const [captureStatus, setCaptureStatus] = useState("");
  const [progress, setProgress] = useState(0);
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
  const navigate = useBbNavigate();
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
      return;
    }
    void loaded
      .load(url)
      .then((loadedStats) => {
        if (life.current && loadedStats) {
          setStats({ ...loadedStats });
          reportLoad.current(loadedStats);
        }
        return undefined;
      })
      .catch((error) => {
        if (life.current) setError(causeMessage(error));
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
      engine.current?.renderAt(
        playing ? elapsed : 0,
        turntable ? (elapsed * Math.PI) / 5 : undefined,
      );
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
      setCaptureStatus("");
      setProgress(0);
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
          (value, done) => {
            if (!life.current) return;
            setCaptureStatus(value);
            setProgress(done);
          },
          controller.signal,
        );
        if (life.current) setResult(captured);
        return captured;
      } catch (error) {
        if (life.current) setError(causeMessage(error));
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
      // Space on a focused button is that button's own activation.
      if (event.code === "Space" && clip && !(event.target instanceof HTMLButtonElement)) {
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
  const shownTime = playing ? playhead : time;
  const available = stats
    ? modeAvailability(stats.facts)
    : reviewModes.map((item) => Object.assign({}, item, { reason: null }));
  const active = available.find((item) => item.id === mode)!;
  const legend = legends[mode];
  // A scripted view may set a speed outside the menu; keep it selectable rather than blank.
  const speedOptions = speeds.includes(speed) ? speeds : [...speeds, speed].sort((a, b) => a - b);
  const openEvidence = () => navigate.toPluginPanel("studio", { subPath: `${gameId}/evidence` });
  return (
    <div className="gs-review-layout">
      <section className="gs-review-workspace">
        <div className="gs-review-toolbar" role="toolbar" aria-label="View and capture">
          <fieldset className="gs-segment" aria-label="Camera">
            {cameraPresets.map(([id, label]) => (
              <button
                key={id}
                title={id === "three-quarter" ? "Three-quarter" : label}
                aria-label={id === "three-quarter" ? "Three-quarter" : undefined}
                aria-pressed={camera === id}
                disabled={!stats || busy}
                onClick={() => setCamera(id)}
              >
                {label}
              </button>
            ))}
          </fieldset>
          <button
            className="gs-review-toggle-button"
            aria-pressed={turntable}
            title="Turntable"
            disabled={!stats || busy}
            onClick={() => setTurntable((value) => !value)}
          >
            <Icon name="RotateCw" />
            <span className="gs-review-label">Turntable</span>
          </button>
          <span className="gs-review-spacer" />
          <button disabled={!stats || busy} title="Screenshot" onClick={() => shoot()}>
            <Icon name="Camera" />
            <span className="gs-review-label">Screenshot</span>
          </button>
          <button disabled={!stats || busy} title="Record turntable" onClick={() => shoot(true)}>
            <Icon name="Video" />
            <span className="gs-review-label">Record turntable</span>
          </button>
          <button
            className="gs-review-toggle-button"
            aria-pressed={code}
            aria-controls="gs-review-script"
            title="Shot script"
            onClick={() => setCode((value) => !value)}
          >
            <Icon name="Braces" />
            <span className="gs-review-label">Shot script</span>
          </button>
        </div>
        <div
          ref={host}
          className="gs-review-stage"
          aria-label="3D model review viewport"
          data-ready={!!stats}
          data-capturing={busy}
        >
          {stats && (
            <div className="gs-review-overlay gs-review-chip">
              <strong>{active.label}</strong>
              {mode === "weights" && <span>{stats.joints[joint]}</span>}
              {clip && (
                <span>
                  {clip} · {shownTime.toFixed(2)} s
                </span>
              )}
              {legend && (
                <span className="gs-review-legend" data-scale={legend.scale}>
                  <small>{legend.low}</small>
                  <i aria-hidden />
                  <small>{legend.high}</small>
                </span>
              )}
            </div>
          )}
          {!stats && !error && (
            <div className="gs-review-center">
              <Icon name="LoaderCircle" className="gs-review-spin" />
              Loading model…
            </div>
          )}
          {!stats && error && (
            <div className="gs-review-center" role="alert">
              <strong>Could not open this model</strong>
              <span>{error}</span>
            </div>
          )}
          {busy && (
            <output className="gs-review-overlay gs-review-capture">
              <span className="gs-review-rec" aria-hidden />
              <span>{captureStatus || "Capturing…"}</span>
              <button onClick={() => captureController.current?.abort()}>Cancel</button>
              <i
                className="gs-review-progress"
                aria-hidden
                style={{ "--done": progress } as CSSProperties}
              />
            </output>
          )}
          {stats && !busy && (
            <p className="gs-review-overlay gs-review-hint">
              Drag to orbit · Scroll to zoom · Right-drag to pan
            </p>
          )}
          {stats && (error || result) && (
            <div
              className="gs-review-overlay gs-review-notice"
              data-tone={error ? "error" : "success"}
              role={error ? "alert" : "status"}
            >
              <span>
                {error ||
                  `Saved ${result!.files.length} ${result!.files.length === 1 ? "capture" : "captures"} to Evidence`}
              </span>
              {!error && result && (
                <button onClick={openEvidence}>
                  <Icon name="Image" />
                  Open Evidence
                </button>
              )}
              <button
                className="gs-review-icon"
                aria-label="Dismiss"
                onClick={() => {
                  setError("");
                  setResult(null);
                }}
              >
                <Icon name="X" />
              </button>
            </div>
          )}
        </div>
        {stats && stats.clips.length > 0 && (
          <fieldset disabled={busy} className="gs-review-timeline" aria-label="Animation">
            <select
              aria-label="Animation clip"
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
                  {item.name} · {item.duration.toFixed(2)} s
                </option>
              ))}
            </select>
            <button
              className="gs-review-icon"
              disabled={!clip}
              aria-label={playing ? "Pause" : "Play"}
              title={`${playing ? "Pause" : "Play"} (Space)`}
              onClick={() => {
                if (playing) setTime(playheadRef.current);
                setPlaying(!playing);
              }}
            >
              <Icon name={playing ? "Pause" : "Play"} />
            </button>
            <button
              className="gs-review-icon gs-review-toggle-button"
              disabled={!clip}
              aria-label="Loop"
              title="Loop"
              aria-pressed={loop}
              onClick={() => setLoop((value) => !value)}
            >
              <Icon name="Repeat" />
            </button>
            <div className="gs-review-scrub">
              <input
                aria-label="Animation time"
                type="range"
                min={0}
                max={duration}
                step={0.01}
                value={shownTime}
                disabled={!clip}
                onChange={(event) => {
                  setPlaying(false);
                  setTime(Number(event.target.value));
                }}
              />
              {clip && duration > 0 && (
                <div className="gs-review-ruler" aria-hidden>
                  {rulerTicks(duration).map((at) => (
                    <span key={at} style={{ "--at": at / duration } as CSSProperties}>
                      {at}s
                    </span>
                  ))}
                </div>
              )}
            </div>
            <output className="gs-review-time">
              {shownTime.toFixed(2)}
              <small> / {duration.toFixed(2)} s</small>
            </output>
            <select
              className="gs-review-speed"
              aria-label="Playback speed"
              title="Playback speed"
              value={speed}
              disabled={!clip}
              onChange={(event) => setSpeed(Number(event.target.value))}
            >
              {speedOptions.map((value) => (
                <option key={value} value={value}>
                  {value}×
                </option>
              ))}
            </select>
          </fieldset>
        )}
        {code && (
          <section id="gs-review-script" className="gs-review-code" aria-label="Shot script">
            <header>
              <div>
                <strong>Shot script</strong>
                <small>
                  Renders each shot at fixed timesteps and saves PNG and MP4 files to Evidence.
                  Agents call <code>window.gameStudioModelReview.capture(script)</code>.
                </small>
              </div>
              <button
                className="gs-review-primary"
                disabled={!stats || busy}
                onClick={() => void capture(script).catch(() => {})}
              >
                <Icon name="Play" />
                Run script
              </button>
            </header>
            <textarea
              aria-label="Shot script JSON"
              spellCheck={false}
              disabled={busy}
              value={script}
              onChange={(event) => setScript(event.target.value)}
            />
          </section>
        )}
      </section>
      <aside className="gs-review-sidebar" aria-label="Review controls">
        <section>
          <h2>Review mode</h2>
          {modeGroups.map((group) => (
            <div className="gs-review-group" key={group.id}>
              <h3>{group.label}</h3>
              {available
                .filter((item) => item.group === group.id)
                .map((item) => (
                  <button
                    key={item.id}
                    className="gs-review-mode"
                    title={item.reason ?? undefined}
                    disabled={!stats || !!item.reason || busy}
                    aria-pressed={item.id === mode}
                    onClick={() => setMode(item.id)}
                  >
                    <span>{item.label}</span>
                    {item.reason ? (
                      <small>{item.reason}</small>
                    ) : "key" in item ? (
                      <kbd>{item.key}</kbd>
                    ) : null}
                  </button>
                ))}
              {group.id === "rig" && mode === "weights" && stats && (
                <label className="gs-review-field">
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
            </div>
          ))}
        </section>
        {stats && stats.textures.length > 0 && (
          <section className="gs-review-textures">
            <h2>
              Textures <small>{stats.textures.length}</small>
            </h2>
            <ul>
              {stats.textures.map((item) => (
                <li key={item.id} title={item.name}>
                  <TextureThumb id={item.id} engine={engine} />
                  <span>{item.name}</span>
                  <small>
                    {item.width} × {item.height}
                  </small>
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>
    </div>
  );
}
