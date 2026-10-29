import { useState, type ReactNode } from "react";
import { unityYamlKind } from "./model.ts";
import type { UnityCitation, UnityDiff, UnityMetaDiff } from "./model.ts";
import "./app.css";

const labels: Record<string, string> = {
  m_LocalPosition: "Position",
  m_LocalRotation: "Rotation",
  m_LocalScale: "Scale",
  m_LocalEulerAnglesHint: "Euler angles",
  m_Father: "Parent",
  m_Name: "Name",
  m_IsActive: "Active",
  m_Enabled: "Enabled",
  m_TagString: "Tag",
  m_Layer: "Layer",
  m_Script: "Script",
  m_GameObject: "GameObject",
  m_Component: "Components",
};
/** A serialized field name as the Inspector shows it: `m_assetBundleName` reads "Asset Bundle Name". */
function propertyLabel(path: string): string {
  return path
    .split(".")
    .map((part) => {
      const words = part.replace(/^(?:m_|_)/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
      return labels[part] ?? words.charAt(0).toUpperCase() + words.slice(1);
    })
    .join(" › ");
}
const COLOR = /^\{r: (-?[\d.e-]+), g: (-?[\d.e-]+), b: (-?[\d.e-]+), a: (-?[\d.e-]+)\}$/;

/** A serialized Unity color as CSS, so a changed tint shows as a swatch. */
function cssColor(value: string): string | null {
  const match = COLOR.exec(value);
  if (!match) return null;
  const [r, g, b, a] = match.slice(1).map(Number) as [number, number, number, number];
  if (![r, g, b, a].every(Number.isFinite)) return null;
  const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);
  return `rgb(${channel(r)} ${channel(g)} ${channel(b)} / ${Math.min(1, Math.max(0, a))})`;
}

function Value({ value, missing = "Not present" }: { value: string | null; missing?: string }) {
  if (value === null) return <code>{missing}</code>;
  const color = cssColor(value);
  return (
    <code>
      {color ? (
        <span className="unity-diff-swatch" style={{ background: color }} aria-hidden="true" />
      ) : null}
      {value}
    </code>
  );
}

type Badge = "added" | "removed" | "modified";
/** A table row is the parsed property itself; the model's `kind` says which property shape every row has. */
type DiffRow = UnityDiff["groups"][number]["components"][number]["properties"][number];
type CitationRow = UnityCitation["groups"][number]["components"][number]["properties"][number];

interface RenderComponent<Row> {
  id: string;
  type: string;
  badge: Badge | null;
  rows: readonly Row[];
}
interface RenderGroup<Row> {
  id: string;
  name: string;
  hierarchy: string;
  badge: Badge | null;
  components: readonly RenderComponent<Row>[];
}
/**
 * What the inspector draws. `kind` fixes the row payload (a diff row has `before` / `after`, a
 * citation row has `value`) and selects the header, so the two cannot disagree.
 */
export type RenderModel =
  | { kind: "diff"; propertyCount: number; groups: readonly RenderGroup<DiffRow>[] }
  | { kind: "citation"; propertyCount: number; groups: readonly RenderGroup<CitationRow>[] };

export function fromDiff(diff: UnityDiff): Extract<RenderModel, { kind: "diff" }> {
  return {
    kind: "diff",
    propertyCount: diff.propertyCount,
    groups: diff.groups.map((group) => ({
      id: group.id,
      name: group.name,
      hierarchy: group.hierarchy,
      badge: group.status,
      components: group.components.map((component) => ({
        id: component.id,
        type: component.type,
        badge: component.status,
        rows: component.properties,
      })),
    })),
  };
}
export function fromCitation(citation: UnityCitation): Extract<RenderModel, { kind: "citation" }> {
  return {
    kind: "citation",
    propertyCount: citation.propertyCount,
    groups: citation.groups.map((group) => ({
      id: group.id,
      name: group.name,
      hierarchy: group.hierarchy,
      badge: null,
      components: group.components.map((component) => ({
        id: component.id,
        type: component.type,
        badge: null,
        rows: component.properties,
      })),
    })),
  };
}

/** How one kind shows: the title word, the column headers, and the cells a row fills them with. */
interface View<Row> {
  label: string;
  columns: readonly string[];
  cells: (row: Row) => ReactNode;
}
const views: { diff: View<DiffRow>; citation: View<CitationRow> } = {
  diff: {
    label: "changes",
    columns: ["Before", "After"],
    cells: (row) => (
      <>
        <td className="unity-diff-before">
          <Value value={row.before} />
        </td>
        <td className="unity-diff-after">
          <Value value={row.after} />
        </td>
      </>
    ),
  },
  citation: {
    label: "properties",
    columns: ["Value"],
    cells: (row) => (
      <td className="unity-diff-value">
        <Value value={row.value} />
      </td>
    ),
  },
};

function ChangeBadge({ status }: { status: Badge }) {
  return <span className={`unity-diff-badge unity-diff-${status}`}>{status}</span>;
}
function ComponentCard<Row extends DiffRow | CitationRow>({
  component,
  view,
}: {
  component: RenderComponent<Row>;
  view: View<Row>;
}) {
  return (
    <details className="unity-diff-component" open>
      <summary>
        <span className="unity-diff-component-name">{component.type}</span>
        <span className="unity-diff-id" title="Unity file ID">
          #{component.id}
        </span>
        {component.badge ? <ChangeBadge status={component.badge} /> : null}
      </summary>
      {component.rows.length ? (
        <div className="unity-diff-table-wrap">
          <table className="unity-diff-properties">
            <thead>
              <tr>
                <th scope="col">Property</th>
                {view.columns.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {component.rows.map((row) => (
                <tr key={row.path}>
                  <th scope="row" title={row.path}>
                    {propertyLabel(row.label ?? row.path)}
                    {row.target ? (
                      <span className="unity-diff-property-target">#{row.target}</span>
                    ) : null}
                  </th>
                  {view.cells(row)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="unity-diff-empty">No serialized properties.</p>
      )}
    </details>
  );
}
function Groups<Row extends DiffRow | CitationRow>({
  groups,
  view,
}: {
  groups: readonly RenderGroup<Row>[];
  view: View<Row>;
}) {
  return (
    <div className="unity-diff-groups">
      {groups.map((group) => (
        <details key={group.id} className="unity-diff-object" open>
          <summary>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="m12 3 9 5v8l-9 5-9-5V8l9-5ZM3 8l9 5 9-5M12 13v8M7.5 5.5l9 5" />
            </svg>
            <span className="unity-diff-object-label">
              {group.hierarchy ? (
                <span className="unity-diff-hierarchy">{group.hierarchy} /</span>
              ) : null}
              <strong>{group.name}</strong>
            </span>
            {group.badge ? <ChangeBadge status={group.badge} /> : null}
          </summary>
          <div className="unity-diff-components">
            {group.components.map((component) => (
              <ComponentCard key={component.id} component={component} view={view} />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function UnityInspector({
  model,
  path,
  raw,
}: {
  model: RenderModel;
  path: string;
  /** The YAML to toggle to. Without it, there is no toggle: the host shows text its own way. */
  raw?: ReactNode;
}) {
  const [yaml, setYaml] = useState(false);
  const { label } = views[model.kind];
  const componentCount = model.groups.reduce((sum, group) => sum + group.components.length, 0);
  const groups =
    model.kind === "diff" ? (
      <Groups groups={model.groups} view={views.diff} />
    ) : (
      <Groups groups={model.groups} view={views.citation} />
    );
  return (
    <section className="unity-diff" aria-label={`Unity ${label} in ${path}`}>
      <div className="unity-diff-toolbar">
        <div className="unity-diff-title">
          <strong>{`${unityYamlKind(path) ?? "Asset"} ${label}`}</strong>
          <span>
            {model.groups.length} {model.groups.length === 1 ? "object" : "objects"} ·{" "}
            {componentCount} {componentCount === 1 ? "component" : "components"} ·{" "}
            {model.propertyCount} {model.propertyCount === 1 ? "property" : "properties"}
          </span>
        </div>
        {raw === undefined ? null : (
          <button type="button" aria-pressed={yaml} onClick={() => setYaml((value) => !value)}>
            {yaml ? "Object view" : "Raw YAML"}
          </button>
        )}
      </div>
      {yaml && raw !== undefined ? raw : groups}
    </section>
  );
}

export function UnityDiffView({
  diff,
  ...props
}: {
  diff: UnityDiff;
  path: string;
  raw?: ReactNode;
}) {
  return <UnityInspector model={fromDiff(diff)} {...props} />;
}
export function UnityCitationView({
  citation,
  ...props
}: {
  citation: UnityCitation;
  path: string;
  raw: ReactNode;
}) {
  return <UnityInspector model={fromCitation(citation)} {...props} />;
}

/** A `.meta` change: its GUID, its importer, and every import setting that moved. */
export function UnityMetaDiffView({
  diff,
  path,
  raw,
}: {
  diff: UnityMetaDiff;
  path: string;
  raw?: ReactNode;
}) {
  const [yaml, setYaml] = useState(false);
  const { guid, importer } = diff;
  const guidChanged = guid.before !== null && guid.after !== null && guid.before !== guid.after;
  return (
    <section className="unity-diff" aria-label={`Import settings changes in ${path}`}>
      <div className="unity-diff-toolbar">
        <div className="unity-diff-title">
          <strong>Import settings changes</strong>
          <span>
            {importer.after ?? importer.before ?? "No importer"} · {diff.propertyCount}{" "}
            {diff.propertyCount === 1 ? "setting" : "settings"}
          </span>
        </div>
        {raw === undefined ? null : (
          <button type="button" aria-pressed={yaml} onClick={() => setYaml((value) => !value)}>
            {yaml ? "Settings view" : "Raw YAML"}
          </button>
        )}
      </div>
      {yaml && raw !== undefined ? (
        raw
      ) : (
        <div className="unity-diff-groups">
          {guidChanged ? (
            <p className="unity-diff-warning" role="alert">
              The GUID changed. Scenes, prefabs, and materials that reference this asset by its old
              GUID lose the reference.
            </p>
          ) : null}
          <dl className="unity-meta-facts">
            <dt>GUID</dt>
            <dd>
              {guid.before === guid.after ? (
                <code>{guid.after ?? "None"}</code>
              ) : (
                <>
                  <code className="unity-diff-before">{guid.before ?? "None"}</code>
                  {" → "}
                  <code className="unity-diff-after">{guid.after ?? "None"}</code>
                </>
              )}
            </dd>
            <dt>Importer</dt>
            <dd>
              {importer.before === importer.after ? (
                <code>{importer.after ?? "None"}</code>
              ) : (
                <>
                  <code className="unity-diff-before">{importer.before ?? "None"}</code>
                  {" → "}
                  <code className="unity-diff-after">{importer.after ?? "None"}</code>
                </>
              )}
            </dd>
          </dl>
          {diff.properties.length ? (
            <div className="unity-diff-object unity-diff-table-wrap">
              <table className="unity-diff-properties">
                <thead>
                  <tr>
                    <th scope="col">Setting</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.properties.map((property) => (
                    <tr key={property.path}>
                      <th scope="row" title={property.path}>
                        {propertyLabel(property.path)}
                      </th>
                      <td className="unity-diff-before">
                        <Value value={property.before} />
                      </td>
                      <td className="unity-diff-after">
                        <Value value={property.after} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="unity-diff-empty">No import settings changed.</p>
          )}
        </div>
      )}
    </section>
  );
}
