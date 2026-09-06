import { useState } from "react";
import type { RefObject } from "react";
import type { TraceEvent } from "../shared/model.ts";
import { rpc } from "./rpc.ts";
import { Empty, Evidence, QueryError } from "./controls.tsx";
import { defaultTraceRenderers } from "./renderers.tsx";
import type { TraceRendererRegistry } from "./renderers.tsx";
import { JsonView } from "./json-view.tsx";
import { decodeRawPage } from "./raw-text.ts";

function RawRecord({ hostId, eventId }: { hostId: string; eventId: string }) {
  const [offsets, setOffsets] = useState([0]);
  const offset = offsets.at(-1) ?? 0;
  const result = rpc.raw.useQuery(
    { hostId, eventId, offset: Math.max(0, offset - 3), limit: 65_542 },
    { gcTime: 0, staleTime: 0, retry: false },
  );
  if (result.isPending) return <Empty title="Reading source record…" />;
  if (result.error) return <QueryError error={result.error} retry={() => void result.refetch()} />;
  if (!result.data) return null;
  const data = result.data;
  if (data.state !== "available")
    return (
      <output className="tr-notice">
        {data.message ?? `Source ${data.state}. Refresh the index to continue.`}
      </output>
    );
  const text = decodeRawPage(data.base64, data.offset, data.nextOffset === null);
  let value: unknown;
  if (offset === 0 && data.nextOffset === null) {
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
  }
  return (
    <div className="tr-raw">
      <p className="tr-raw-range">
        Original JSONL · {data.totalBytes.toLocaleString()} bytes
        {data.nextOffset !== null || offset > 0
          ? ` · overlapping chunk from byte ${data.offset.toLocaleString()}`
          : ""}
      </p>
      <pre className="tr-code">{text}</pre>
      {value !== undefined && (
        <details className="tr-detail-section">
          <summary>Explore JSON structure</summary>
          <JsonView value={value} />
        </details>
      )}
      {(offset > 0 || data.nextOffset !== null) && (
        <div className="tr-pages">
          <button disabled={offset === 0} onClick={() => setOffsets(offsets.slice(0, -1))}>
            Previous chunk
          </button>
          <span>64 KiB chunks</span>
          <button
            disabled={data.nextOffset === null}
            onClick={() => {
              if (data.nextOffset !== null) setOffsets([...offsets, offset + 65_536]);
            }}
          >
            Next chunk
          </button>
        </div>
      )}
    </div>
  );
}

export function Inspector({
  hostId,
  selected,
  raw,
  onRaw,
  onSelect,
  inspectorRef,
  onBack,
  renderers = defaultTraceRenderers,
}: {
  hostId: string;
  selected: TraceEvent;
  raw: boolean;
  onRaw: (value: boolean) => void;
  onSelect: (event: TraceEvent) => void;
  inspectorRef: RefObject<HTMLElement | null>;
  onBack?: () => void;
  renderers?: TraceRendererRegistry;
}) {
  const result = rpc.event.useQuery(
    { hostId, eventId: selected.id },
    { gcTime: 0, staleTime: 1000, retry: false, enabled: !raw },
  );
  const data = result.data;
  const event = data?.event ?? selected;
  const Renderer = renderers.resolve(event.template);
  return (
    <section className="tr-inspector" ref={inspectorRef} tabIndex={-1} aria-label="Event inspector">
      <div className="tr-column-heading">
        {onBack && (
          <button className="tr-back-button" aria-label="Back to timeline" onClick={onBack}>
            ‹
          </button>
        )}
        <span>Inspector</span>
        <div className="tr-segment">
          <button aria-pressed={!raw} onClick={() => onRaw(false)}>
            Formatted
          </button>
          <button aria-pressed={raw} onClick={() => onRaw(true)}>
            Raw <kbd>r</kbd>
          </button>
        </div>
      </div>
      <div className="tr-inspector-scroll">
        <div className="tr-inspector-title">
          <span className="tr-eyebrow">{event.role ?? event.kind.replaceAll("_", " ")}</span>
          <h2>{event.title}</h2>
          <div className="tr-inspector-meta">
            {event.tool?.name ?? event.template}
            {event.tool ? ` · ${event.tool.status}` : ""}
          </div>
        </div>
        <Evidence evidence={event.evidence} />
        {raw ? (
          <RawRecord key={event.id} hostId={hostId} eventId={event.id} />
        ) : result.isPending ? (
          <Empty title="Loading event…" />
        ) : result.error ? (
          <QueryError error={result.error} retry={() => void result.refetch()} />
        ) : data ? (
          <>
            {data.sourceState !== "available" && (
              <output className="tr-notice">
                {data.message ?? `Source ${data.sourceState}. Refresh the index to continue.`}
              </output>
            )}
            {data.bodyTruncated && (
              <div className="tr-notice">
                Preview shortened. Open raw to inspect the complete source record.
              </div>
            )}
            {data.body && <Renderer event={event} body={data.body} related={data.related} />}
            {data.related.length > 0 && (
              <div className="tr-detail-section">
                <h3>Related events</h3>
                {data.related.map((related) => (
                  <button className="tr-related" key={related.id} onClick={() => onSelect(related)}>
                    {related.kind === "tool_result" ? "↙" : "↗"} {related.title}
                    <small>L{related.provenance.line}</small>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : null}
        <details className="tr-provenance">
          <summary>Source · line {event.provenance.line}</summary>
          <dl>
            <dt>Path</dt>
            <dd>{event.provenance.path}</dd>
            <dt>Record pointer</dt>
            <dd>{event.provenance.pointer || "/"}</dd>
            <dt>Event ID</dt>
            <dd>{event.id}</dd>
            <dt>Bytes</dt>
            <dd>
              {event.provenance.byteOffset} + {event.provenance.byteLength}
            </dd>
            <dt>Record SHA-256</dt>
            <dd>{event.provenance.recordHash}</dd>
          </dl>
        </details>
      </div>
    </section>
  );
}
