import { useEffect, useRef, useState } from "react";
import { experimental_usePluginId as usePluginId } from "@get-bb/plugin-sdk/app";
import { blobUrl } from "../../shared/blob-url.ts";
import type { ModelFormat } from "../../shared/previews.ts";
import type { ChangedFile, Comparison, ComparisonSide } from "../../shared/schema.ts";
import { Button } from "../components/ui/button.tsx";
import { Notice, RetryButton } from "../notice.tsx";
import { cn } from "../lib/utils.ts";
import { SIDE_LABEL, type SideUrls } from "./common.tsx";
import {
  type Layout,
  type LoadedModel,
  type ModelStats,
  type Stage,
  createStage,
  loadModel,
  releaseModel,
  siblingPath,
} from "./model-engine.ts";
import { type ThreeKit, loadThreeKit } from "./three-kit.ts";

/*
 * Two versions of a model, orbited together, with what changed in numbers
 * under them: meshes, vertices, triangles, materials, and size.
 */

/** Side by side needs room for two useful views; narrower cards stack them. */
const SIDE_BY_SIDE_MIN_PX = 520;
const VIEW_PX = 300;

type SideState = { model: LoadedModel } | { error: string } | null;
type Loaded = { kit: ThreeKit | null; base: SideState; head: SideState; kitError: string | null };
const NOTHING: Loaded = { kit: null, base: null, head: null, kitError: null };

function useModels(
  comparison: Comparison,
  file: Pick<ChangedFile, "path" | "previousPath">,
  urls: SideUrls,
  format: ModelFormat,
  attempt: number,
): Loaded {
  const pluginId = usePluginId();
  const [loaded, setLoaded] = useState<{ key: string; value: Loaded } | null>(null);
  const key = JSON.stringify([urls.base, urls.head, file.path, file.previousPath, format, attempt]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      let kit: ThreeKit;
      try {
        kit = await loadThreeKit(pluginId);
      } catch {
        if (!controller.signal.aborted) {
          setLoaded({ key, value: { ...NOTHING, kitError: "The 3D viewer could not load." } });
        }
        return;
      }
      const value: Loaded = { ...NOTHING, kit };
      await Promise.all(
        (["base", "head"] as const).map(async (side: ComparisonSide) => {
          const url = urls[side];
          if (!url) return;
          const path = side === "base" ? (file.previousPath ?? file.path) : file.path;
          const resolve = (reference: string) => {
            const sibling = siblingPath(path, reference);
            return sibling ? blobUrl(pluginId, comparison, side, sibling) : null;
          };
          try {
            value[side] = { model: await loadModel(kit, format, url, resolve, controller.signal) };
          } catch (error) {
            value[side] = { error: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
      if (!controller.signal.aborted) setLoaded({ key, value });
      else {
        // Loaded after the card closed or moved on: nothing will draw or free it.
        for (const side of ["base", "head"] as const) {
          const state = value[side];
          if (state && "model" in state) releaseModel(kit, state.model);
        }
      }
    })();
    return () => controller.abort();
    // `key` names every input the read depends on.
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return loaded?.key === key ? loaded.value : NOTHING;
}

const STAT_ROWS: readonly { label: string; read: (stats: ModelStats) => string }[] = [
  { label: "Meshes", read: (stats) => stats.meshes.toLocaleString() },
  { label: "Vertices", read: (stats) => stats.vertices.toLocaleString() },
  { label: "Triangles", read: (stats) => stats.triangles.toLocaleString() },
  { label: "Materials", read: (stats) => stats.materials.toLocaleString() },
  { label: "Textures", read: (stats) => stats.textures.toLocaleString() },
  { label: "Animations", read: (stats) => stats.animations.toLocaleString() },
  {
    label: "Size",
    read: (stats) =>
      stats.size
        .map((value) => (Math.abs(value) >= 100 ? value.toFixed(0) : value.toPrecision(3)))
        .join(" × "),
  },
];

function Stats({ base, head }: { base: ModelStats | null; head: ModelStats | null }) {
  const sides = [
    ...(base ? [{ side: "base" as const, stats: base }] : []),
    ...(head ? [{ side: "head" as const, stats: head }] : []),
  ];
  if (!sides.length) return null;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-[11px] tabular-nums">
        <thead className="bg-muted text-muted-foreground">
          <tr>
            <th scope="col" className="px-2.5 py-1.5 font-medium">
              Model
            </th>
            {sides.map(({ side }) => (
              <th key={side} scope="col" className="px-2.5 py-1.5 font-medium">
                {SIDE_LABEL[side]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {STAT_ROWS.map((row) => {
            const values = sides.map(({ stats }) => row.read(stats));
            const changed = values.length === 2 && values[0] !== values[1];
            return (
              <tr key={row.label} className="border-t border-border">
                <th scope="row" className="px-2.5 py-1.5 font-medium">
                  {row.label}
                </th>
                {values.map((value, index) => (
                  <td
                    key={sides[index]!.side}
                    className={cn(
                      "px-2.5 py-1.5",
                      changed && (index === 0 ? "text-diff-removed" : "text-diff-added"),
                    )}
                  >
                    {value}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ModelDiff({
  comparison,
  file,
  urls,
  format,
}: {
  comparison: Comparison;
  file: Pick<ChangedFile, "path" | "previousPath">;
  urls: SideUrls;
  format: ModelFormat;
}) {
  const [attempt, setAttempt] = useState(0);
  const loaded = useModels(comparison, file, urls, format, attempt);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  const [layout, setLayout] = useState<Layout>("side");
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [wireframe, setWireframe] = useState(false);
  const sides = (["base", "head"] as const).filter((side) => urls[side] !== null);
  const model = (side: ComparisonSide) => {
    const state = loaded[side];
    return state && "model" in state ? state.model : null;
  };
  const base = model("base");
  const head = model("head");
  const { kit } = loaded;

  // The views follow the card's own width, not the window's.
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setLayout((entry?.contentRect.width ?? 0) >= SIDE_BY_SIDE_MIN_PX ? "side" : "stack");
      stage.current?.draw();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const slotKey = sides.join(",");
  useEffect(() => {
    const element = canvas.current;
    if (!element || !kit || (!base && !head)) return;
    const slots = slotKey.split(",") as ComparisonSide[];
    const made = createStage(kit, element, { base, head }, slots, () => layoutRef.current);
    stage.current = made;
    made.draw();
    return () => {
      made.dispose();
      if (stage.current === made) stage.current = null;
    };
  }, [kit, base, head, slotKey]);

  // A texture that fails after the model shows still adds its warning.
  const [, setLate] = useState(0);
  useEffect(() => {
    const stops = [base, head].map((found) => found?.watch(() => setLate((count) => count + 1)));
    return () => {
      for (const stop of stops) stop?.();
    };
  }, [base, head]);

  useEffect(() => stage.current?.draw(), [layout]);
  useEffect(() => stage.current?.setWireframe(wireframe), [wireframe, base, head]);

  if (loaded.kitError) {
    return (
      <Notice
        tone="error"
        title="Model preview unavailable"
        className="m-3"
        action={<RetryButton onRetry={() => setAttempt((count) => count + 1)} />}
      >
        {loaded.kitError}
      </Notice>
    );
  }
  const pending = sides.some((side) => loaded[side] === null);
  const stacked = layout === "stack" && sides.length === 2;
  const warnings = sides.flatMap((side) => {
    const found = model(side);
    return found ? found.warnings().map((text) => `${SIDE_LABEL[side]}: ${text}`) : [];
  });
  const failed = sides.flatMap((side) => {
    const state = loaded[side];
    return state && "error" in state ? [{ side, error: state.error }] : [];
  });

  return (
    <div ref={box} className="flex flex-col gap-2.5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[11px] font-normal"
          aria-pressed={wireframe}
          onClick={() => setWireframe((on) => !on)}
        >
          Wireframe
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[11px] font-normal"
          onClick={() => stage.current?.resetView()}
        >
          Reset view
        </Button>
        <span className="text-[11px] text-muted-foreground">
          Drag to orbit, scroll to zoom. Both views move together.
        </span>
      </div>
      <div
        className="relative overflow-hidden rounded-md border border-border bg-muted/40"
        style={{ height: VIEW_PX * (stacked ? 2 : 1) }}
      >
        <canvas
          ref={canvas}
          className="block size-full touch-none"
          aria-label={`3D views of ${file.path}`}
          // A drawing reads as an image to assistive technology; an `<img>` cannot hold one.
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          role="img"
        />
        <div
          className={cn(
            "pointer-events-none absolute inset-0 grid",
            stacked ? "grid-rows-2" : "grid-flow-col auto-cols-fr",
          )}
        >
          {sides.map((side) => {
            const state = loaded[side];
            return (
              <div
                key={side}
                className="relative border-border not-first:border-s data-[stacked=true]:not-first:border-s-0 data-[stacked=true]:not-first:border-t"
                data-stacked={stacked}
              >
                <span
                  className={cn(
                    "absolute top-1.5 left-2 text-[11px] font-medium",
                    side === "base" ? "text-diff-removed" : "text-diff-added",
                  )}
                >
                  {SIDE_LABEL[side]}
                </span>
                {state === null ? (
                  <span className="absolute inset-0 grid place-items-center text-[11px] text-muted-foreground">
                    Loading the model…
                  </span>
                ) : "error" in state ? (
                  <span className="absolute inset-0 grid place-items-center p-4 text-center text-[11px] text-destructive-text">
                    {state.error}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {failed.length && !pending ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2.5 text-xs font-normal"
            onClick={() => setAttempt((count) => count + 1)}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {warnings.length ? (
        <ul className="list-disc ps-5 text-[11px] text-warning-text">
          {warnings.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      ) : null}
      <Stats base={base?.stats ?? null} head={head?.stats ?? null} />
    </div>
  );
}
