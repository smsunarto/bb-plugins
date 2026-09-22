import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { ReactCompareSlider, ReactCompareSliderImage } from "react-compare-slider";
import { buildPreviewUrl } from "./inline-video.ts";
import type { PreviewSource } from "../shared/contract.ts";
import { parseImageAnnotations, type ImageAnnotation } from "./image-annotations.ts";
import "./smart-image-compare.css";

/** Local images use the same authenticated, host-confined file routes as inline previews. */
export function imageCompareUrl(value: string, threadId: string, source: PreviewSource): string {
  const path = value.trim();
  if (/^https?:\/\//iu.test(path)) {
    const url = new URL(path);
    if (url.username || url.password) throw new Error("Image URLs must not contain credentials.");
    return url.href;
  }
  if (
    !path ||
    /^[a-z][a-z\d+.-]*:|^\//iu.test(path) ||
    /[\\\0]/u.test(path) ||
    path.split("/").some((part) => part === "..")
  ) {
    throw new Error("Images must be workspace-relative paths or HTTP(S) URLs.");
  }
  return buildPreviewUrl(threadId, path, source);
}

export function SmartImageCompareDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const source = attributes.source ?? "workspace";
  if (source !== "workspace" && source !== "thread-storage") {
    return <div role="alert">smart-image-compare source must be workspace or thread-storage.</div>;
  }
  let annotations: ImageAnnotation[];
  let before: string;
  let after: string;
  try {
    annotations = parseImageAnnotations(attributes.annotations);
    before = imageCompareUrl(attributes.before ?? "", message.threadId, source);
    after = imageCompareUrl(attributes.after ?? "", message.threadId, source);
  } catch (error) {
    return <div role="alert">{error instanceof Error ? error.message : String(error)}</div>;
  }
  return (
    <ImageComparison
      key={`${before}:${after}`}
      before={before}
      after={after}
      annotations={annotations}
      beforeLabel={attributes.beforeLabel?.trim() || "Before"}
      afterLabel={attributes.afterLabel?.trim() || "After"}
    />
  );
}

type Size = { width: number; height: number };
function ImageComparison({
  before,
  after,
  beforeLabel,
  afterLabel,
  annotations,
}: {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  annotations: ImageAnnotation[];
}) {
  const [beforeSize, setBeforeSize] = useState<Size | null>(null);
  const [afterSize, setAfterSize] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedIndex = annotations.findIndex(
    (annotation) => JSON.stringify(annotation) === selectedKey,
  );
  const selected = annotations[selectedIndex];
  const selectAnnotation = (key: string) =>
    setSelectedKey((current) => (current === key ? null : key));
  const mismatch =
    beforeSize &&
    afterSize &&
    (beforeSize.width !== afterSize.width || beforeSize.height !== afterSize.height);
  return (
    <figure className="smart-embed smart-image-compare" data-smart-embed-kind="image-compare">
      {failed ? (
        <div role="alert" className="smart-embed-notice smart-embed-notice-error">
          Could not load a comparison image. Check both image paths and access permissions.
        </div>
      ) : null}
      {mismatch ? (
        <div role="alert" className="smart-embed-notice smart-embed-notice-error">
          Images have different dimensions ({beforeSize.width}×{beforeSize.height} and{" "}
          {afterSize.width}×{afterSize.height}). Use matching dimensions and align the subject for
          an accurate comparison.
        </div>
      ) : null}
      <div className="smart-image-compare-stage">
        <ReactCompareSlider
          className="smart-image-compare-slider"
          onlyHandleDraggable
          aria-label={`${beforeLabel} and ${afterLabel} image comparison`}
          style={{
            aspectRatio: beforeSize ? `${beforeSize.width} / ${beforeSize.height}` : "16 / 9",
          }}
          itemOne={
            <div className="smart-image-compare-side">
              <ReactCompareSliderImage
                src={before}
                alt={beforeLabel}
                draggable={false}
                style={{ objectFit: "contain" }}
                onError={() => setFailed(true)}
                onLoad={(event) =>
                  setBeforeSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
              />
              <ImageAnnotations
                annotations={annotations}
                side="before"
                selectedKey={selectedKey}
                onSelect={selectAnnotation}
              />
            </div>
          }
          itemTwo={
            <div className="smart-image-compare-side">
              <ReactCompareSliderImage
                src={after}
                alt={afterLabel}
                draggable={false}
                style={{ objectFit: "contain" }}
                onError={() => setFailed(true)}
                onLoad={(event) =>
                  setAfterSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
              />
              <ImageAnnotations
                annotations={annotations}
                side="after"
                selectedKey={selectedKey}
                onSelect={selectAnnotation}
              />
            </div>
          }
        />
        {selected ? (
          <output className="smart-image-annotation-callout">
            <span>
              <strong>{selectedIndex + 1}.</strong> {selected.label}
            </span>
            <button
              type="button"
              aria-label="Close annotation"
              onClick={() => setSelectedKey(null)}
            >
              ×
            </button>
          </output>
        ) : null}
        <div className="smart-image-compare-labels" aria-hidden="true">
          <span>{beforeLabel}</span>
          <span>{afterLabel}</span>
        </div>
      </div>
    </figure>
  );
}

function ImageAnnotations({
  annotations,
  side,
  selectedKey,
  onSelect,
}: {
  annotations: ImageAnnotation[];
  side: "before" | "after";
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="smart-image-annotations">
      {annotations.map((annotation, index) =>
        annotation.side === side || annotation.side === "both" ? (
          <button
            type="button"
            key={JSON.stringify(annotation)}
            className="smart-image-annotation"
            style={{ left: `${annotation.x}%`, top: `${annotation.y}%` }}
            aria-label={`Annotation ${index + 1}: ${annotation.label}`}
            aria-expanded={selectedKey === JSON.stringify(annotation)}
            onClick={() => onSelect(JSON.stringify(annotation))}
          >
            {index + 1}
          </button>
        ) : null,
      )}
    </div>
  );
}
