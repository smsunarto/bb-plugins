import { useRef, useState } from "react";
import type { FormEvent } from "react";
import type { SourceRoot, TraceStatus } from "../shared/schema.ts";
import { rpc } from "./rpc.ts";
import { providerLabel } from "./controls.tsx";

export function Sources({
  hostId,
  status,
  onClose,
  onSaved,
}: {
  hostId: string;
  status: TraceStatus;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const client = rpc.useClient();
  const [roots, setRoots] = useState<SourceRoot[]>(
    status.roots.map(({ provider, path, enabled }) => ({ provider, path, enabled })),
  );
  const [provider, setProvider] = useState(status.providers[0]?.id ?? "claude-code");
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function open(node: HTMLDialogElement | null) {
    dialog.current = node;
    if (node && !node.open) node.showModal();
  }
  function add(event: FormEvent) {
    event.preventDefault();
    const normalized = path.trim();
    if (!normalized.startsWith("/")) {
      setError("Use an absolute path on the selected host.");
      return;
    }
    if (roots.some((root) => root.path === normalized && root.provider === provider)) {
      setError("That source is already listed.");
      return;
    }
    setRoots([...roots, { provider, path: normalized, enabled: true }]);
    setPath("");
    setError("");
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      await client.configureSources({ hostId, roots });
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save sources.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      className="tr-dialog"
      ref={open}
      onCancel={onClose}
      onClose={onClose}
      aria-labelledby="tr-sources-title"
    >
      <div className="tr-dialog-header">
        <h2 id="tr-sources-title">Trace sources</h2>
        <button onClick={onClose} aria-label="Close sources">
          ×
        </button>
      </div>
      <p>Read Claude Code and Codex session files on this host. Source files are never modified.</p>
      <div className="tr-source-list">
        {roots.map((root) => {
          const current = status.roots.find(
            (item) => item.path === root.path && item.provider === root.provider,
          );
          return (
            <div className="tr-source" key={`${root.provider}:${root.path}`}>
              <label>
                <input
                  type="checkbox"
                  checked={root.enabled}
                  onChange={(event) =>
                    setRoots(
                      roots.map((item) =>
                        item === root ? { ...item, enabled: event.target.checked } : item,
                      ),
                    )
                  }
                />
                <strong>{providerLabel(root.provider)}</strong>
                <span className={`tr-source-state tr-source-${current?.state ?? "ready"}`}>
                  {current?.state ?? "New"}
                </span>
              </label>
              <code>{root.path}</code>
              {current?.message && <small>{current.message}</small>}
              <button
                className="tr-text-button"
                onClick={() => setRoots(roots.filter((item) => item !== root))}
              >
                Remove source
              </button>
            </div>
          );
        })}
      </div>
      <form onSubmit={add} className="tr-source-add">
        <label>
          Provider
          <select value={provider} onChange={(event) => setProvider(event.target.value)}>
            {status.providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Folder or JSONL file
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/absolute/path/to/sessions"
            required
          />
        </label>
        <button type="submit" disabled={roots.length >= 32}>
          Add source
        </button>
      </form>
      {error && (
        <p className="tr-error" role="alert">
          {error}
        </p>
      )}
      <div className="tr-dialog-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="tr-primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save sources"}
        </button>
      </div>
    </dialog>
  );
}
