import { useState } from "react";
import type { ReactNode } from "react";
import type { Tone } from "./labels.ts";

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div className={`cf-notice${error ? " cf-error" : ""}`} role={error ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  dot = false,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
}) {
  return (
    <span className={`cf-badge cf-tone-${tone}`} data-dot={dot || undefined}>
      {children}
    </span>
  );
}

export function CopyButton({
  value,
  label,
  copiedLabel = "Copied",
}: {
  value: string;
  label: string;
  copiedLabel?: string;
}) {
  const [result, setResult] = useState<{ value: string; failed: boolean } | null>(null);
  const copied = result?.value === value && !result.failed;
  const failed = result?.value === value && result.failed;
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setResult({ value, failed: false });
    } catch {
      setResult({ value, failed: true });
    }
  }
  return (
    <span className="cf-copy">
      <button
        type="button"
        className="cf-small"
        onClick={() => void copy()}
        aria-label={`${label}: ${value}`}
        data-copied={copied || undefined}
      >
        {copied ? copiedLabel : label}
      </button>
      {copied && <output className="cf-sr-only">Copied to clipboard.</output>}
      {failed && (
        <span className="cf-copy-error" role="alert">
          Copy failed. Select and copy the value.
        </span>
      )}
    </span>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="cf-empty">
      {title && <h3>{title}</h3>}
      {children && <p>{children}</p>}
      {action && <div className="cf-empty-action">{action}</div>}
    </div>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <h4 className="cf-label">{children}</h4>;
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cf-kv-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="cf-mono">{children}</code>;
}

export function SettingsLink() {
  return (
    <a className="cf-button" href="/settings/plugins/cloudflare">
      Open settings
    </a>
  );
}
