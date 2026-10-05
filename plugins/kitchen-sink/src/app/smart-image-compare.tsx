import { useSdk, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { ReactCompareSlider, ReactCompareSliderImage } from "react-compare-slider";
import { parseImageAnnotations, type ImageAnnotation } from "./image-annotations.ts";
import "./smart-image-compare.css";

type Sdk = ReturnType<typeof useSdk>;
type PreviewSource = "workspace" | "thread-storage";
/** An image the directive names: a remote URL, or a path under the thread's preview root. */
export type ImageRef = { url: string } | { path: string };
type Lease = { baseUrl: string; expiresAtMs: number };

export function parseImageRef(value: string): ImageRef {
  const path = value.trim();
  if (/^https?:\/\//iu.test(path)) {
    const url = new URL(path);
    if (url.username || url.password) throw new Error("Image URLs must not contain credentials.");
    return { url: url.href };
  }
  if (
    !path ||
    /^[a-z][a-z\d+.-]*:|^\//iu.test(path) ||
    /[\\\0]/u.test(path) ||
    path.split("/").some((part) => part === "..")
  ) {
    throw new Error("Images must be workspace-relative paths or HTTP(S) URLs.");
  }
  return { path };
}

/** Renew a cached lease this close to expiry, so a new mount never gets a dying URL. */
const RENEW_MARGIN_MS = 5 * 60_000;
const leases = new Map<string, Promise<Lease>>();

type PreviewRoot = { hostId: string; rootPath: string };

async function previewRoot(
  sdk: Sdk,
  threadId: string,
  source: PreviewSource,
): Promise<PreviewRoot> {
  if (source === "thread-storage") {
    const { hostId, storageRootPath } = await sdk.threads.storageLocation({ threadId });
    return { hostId, rootPath: storageRootPath };
  }
  const thread = await sdk.threads.get({ threadId });
  if (!thread.environmentId) throw new Error("This thread has no workspace.");
  const environment = await sdk.environments.get({ environmentId: thread.environmentId });
  if (!environment.path) throw new Error("This thread's workspace has no readable worktree.");
  return { hostId: environment.hostId, rootPath: environment.path };
}

/**
 * Local images load through a preview lease on the thread's workspace or
 * storage root, the transport bb documents for plugin images. The root is
 * resolved on every mount, so a thread that moves workspace gets the new one.
 * Leases are shared per root until they near expiry; `renew` replaces one.
 */
async function previewLease(
  sdk: Sdk,
  threadId: string,
  source: PreviewSource,
  renew: boolean,
): Promise<Lease> {
  const root = await previewRoot(sdk, threadId, source);
  const key = JSON.stringify([root.hostId, root.rootPath]);
  const cached = renew ? undefined : leases.get(key);
  const lease = cached && (await cached.catch(() => null));
  if (lease && lease.expiresAtMs - Date.now() > RENEW_MARGIN_MS) return lease;
  const fresh = sdk.files.createPreview(root);
  leases.set(key, fresh);
  fresh.catch(() => {
    if (leases.get(key) === fresh) leases.delete(key);
  });
  return fresh;
}

function imageUrl(ref: ImageRef, lease: Lease | null): string | undefined {
  if ("url" in ref) return ref.url;
  if (!lease) return undefined;
  return `${lease.baseUrl}/${ref.path.split("/").map(encodeURIComponent).join("/")}`;
}

type LeaseState = { lease: Lease | null; renewal: number; error: string | null };

/**
 * Resolve both images to URLs. A local image that fails once triggers one
 * lease renewal, which recovers a lease bb dropped early, such as on restart.
 * A remote image has nothing to renew, so its failure reports at once.
 */
function useImageUrls(threadId: string, source: PreviewSource, refs: readonly ImageRef[]) {
  const sdk = useSdk();
  const local = refs.some((ref) => "path" in ref);
  const [renewal, setRenewal] = useState(0);
  const [state, setState] = useState<LeaseState>({ lease: null, renewal: 0, error: null });
  useEffect(() => {
    if (!local) return;
    let live = true;
    previewLease(sdk, threadId, source, renewal > 0).then(
      (lease) => live && setState({ lease, renewal, error: null }),
      (error: unknown) =>
        live &&
        setState({
          lease: null,
          renewal,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return () => {
      live = false;
    };
  }, [sdk, threadId, source, local, renewal]);
  return {
    urls: refs.map((ref) => imageUrl(ref, state.lease)),
    error: state.error,
    /** True when a failed local image should renew the lease instead of reporting. */
    renew: (ref: ImageRef) => {
      if (!("path" in ref) || state.renewal > 0) return false;
      setRenewal(1);
      return true;
    },
  };
}

export function SmartImageCompareDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const source = attributes.source ?? "workspace";
  if (source !== "workspace" && source !== "thread-storage") {
    return <div role="alert">smart-image-compare source must be workspace or thread-storage.</div>;
  }
  let annotations: ImageAnnotation[];
  let before: ImageRef;
  let after: ImageRef;
  try {
    annotations = parseImageAnnotations(attributes.annotations);
    before = parseImageRef(attributes.before ?? "");
    after = parseImageRef(attributes.after ?? "");
  } catch (error) {
    return <div role="alert">{error instanceof Error ? error.message : String(error)}</div>;
  }
  return (
    <ImageComparison
      key={JSON.stringify([message.threadId, source, before, after])}
      threadId={message.threadId}
      source={source}
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
  threadId,
  source,
  before,
  after,
  beforeLabel,
  afterLabel,
  annotations,
}: {
  threadId: string;
  source: PreviewSource;
  before: ImageRef;
  after: ImageRef;
  beforeLabel: string;
  afterLabel: string;
  annotations: ImageAnnotation[];
}) {
  const images = useImageUrls(threadId, source, [before, after]);
  const [beforeUrl, afterUrl] = images.urls;
  const [beforeSize, setBeforeSize] = useState<Size | null>(null);
  const [afterSize, setAfterSize] = useState<Size | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const fail = (label: string, ref: ImageRef) => {
    if (!images.renew(ref)) setFailed((current) => current ?? label);
  };
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
      {images.error ? (
        <div role="alert" className="smart-embed-notice smart-embed-notice-error">
          Could not open this thread's images: {images.error}
        </div>
      ) : failed ? (
        <div role="alert" className="smart-embed-notice smart-embed-notice-error">
          Could not load the {failed} image. Check its path and access permissions.
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
                src={beforeUrl}
                alt={beforeLabel}
                draggable={false}
                style={{ objectFit: "contain" }}
                onError={() => fail(beforeLabel, before)}
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
                src={afterUrl}
                alt={afterLabel}
                draggable={false}
                style={{ objectFit: "contain" }}
                onError={() => fail(afterLabel, after)}
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
