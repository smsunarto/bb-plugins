import { useId, useState } from "react";
import type { NodeKind } from "../shared/schema.ts";
import { Icon } from "./icons.tsx";
import { rpc } from "./rpc.ts";

export function BriefStarters({
  kind,
  hasDraft,
  onInsert,
}: {
  kind: NodeKind;
  hasDraft: boolean;
  onInsert: (text: string) => void;
}) {
  const id = useId();
  const templates = rpc.briefTemplates.useQuery({ kind }, { staleTime: Infinity });
  const [selectedId, setSelectedId] = useState("");
  const selected =
    templates.data?.templates.find((item) => item.id === selectedId) ??
    templates.data?.templates[0];
  if (templates.isPending) return <small className="gs-muted">Loading brief starters…</small>;
  if (templates.error)
    return (
      <button type="button" onClick={() => void templates.refetch()}>
        Retry loading brief starters
      </button>
    );
  if (!selected) return null;
  return (
    <details className="gs-brief-starters">
      <summary>
        Brief starters
        <Icon name="ChevronDown" />
      </summary>
      <label htmlFor={id}>Start with a purpose</label>
      <select id={id} value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
        {templates.data?.templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.label}
          </option>
        ))}
      </select>
      <p className="gs-muted">Fill in the brackets, then connect your references below.</p>
      <button type="button" onClick={() => onInsert(selected.text)}>
        {hasDraft ? "Append starter to brief" : "Insert starter"}
      </button>
    </details>
  );
}
