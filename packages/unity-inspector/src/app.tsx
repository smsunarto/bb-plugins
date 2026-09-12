import { useState, type ReactNode } from "react";
import type { UnityDiff, UnityCitation } from "./model.ts";
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
function propertyLabel(path: string): string {
  return path
    .split(".")
    .map(
      (part) => labels[part] ?? part.replace(/^(?:m_|_)/, "").replace(/([a-z])([A-Z])/g, "$1 $2"),
    )
    .join(" › ");
}
function ChangeBadge({ status }: { status: "added" | "removed" | "modified" }) {
  return <span className={`unity-diff-badge unity-diff-${status}`}>{status}</span>;
}
function ComponentCard({
  component,
  citation,
}: {
  component:
    | UnityDiff["groups"][number]["components"][number]
    | UnityCitation["groups"][number]["components"][number];
  citation: boolean;
}) {
  return (
    <details className="unity-diff-component" open>
      <summary>
        <span className="unity-diff-component-name">{component.type}</span>
        <span className="unity-diff-id" title="Unity file ID">
          #{component.id}
        </span>
        {"status" in component ? <ChangeBadge status={component.status} /> : null}
      </summary>
      {component.properties.length ? (
        <div className="unity-diff-table-wrap">
          <table className="unity-diff-properties">
            <thead>
              <tr>
                <th scope="col">Property</th>
                {citation ? (
                  <th scope="col">Value</th>
                ) : (
                  <>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {component.properties.map((property) => (
                <tr key={property.path}>
                  <th scope="row" title={property.path}>
                    {propertyLabel(property.label ?? property.path)}
                    {property.target ? (
                      <span className="unity-diff-property-target">#{property.target}</span>
                    ) : null}
                  </th>
                  {"value" in property ? (
                    <td>
                      <code>{property.value}</code>
                    </td>
                  ) : (
                    <>
                      <td className="unity-diff-before">
                        <code>{property.before ?? "Not present"}</code>
                      </td>
                      <td className="unity-diff-after">
                        <code>{property.after ?? "Not present"}</code>
                      </td>
                    </>
                  )}
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

function UnityInspector({
  diff,
  path,
  raw,
  citation = false,
}: {
  diff: UnityDiff | UnityCitation;
  citation?: boolean;
  path: string;
  raw: ReactNode;
}) {
  const [yaml, setYaml] = useState(false);
  const componentCount = diff.groups.reduce((sum, group) => sum + group.components.length, 0);
  return (
    <section
      className="unity-diff"
      aria-label={`Unity ${citation ? "properties" : "changes"} in ${path}`}
    >
      <div className="unity-diff-toolbar">
        <div className="unity-diff-title">
          <strong>{`${/\.unity$/i.test(path) ? "Scene" : "Prefab"} ${citation ? "properties" : "changes"}`}</strong>
          <span>
            {diff.groups.length} {diff.groups.length === 1 ? "object" : "objects"} ·{" "}
            {componentCount} {componentCount === 1 ? "component" : "components"} ·{" "}
            {diff.propertyCount} {diff.propertyCount === 1 ? "property" : "properties"}
          </span>
        </div>
        <button type="button" aria-pressed={yaml} onClick={() => setYaml((value) => !value)}>
          {yaml ? "Object view" : "Raw YAML"}
        </button>
      </div>
      {yaml ? (
        raw
      ) : (
        <div className="unity-diff-groups">
          {diff.groups.map((group) => (
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
                {"status" in group ? <ChangeBadge status={group.status} /> : null}
              </summary>
              <div className="unity-diff-components">
                {group.components.map((component) => (
                  <ComponentCard key={component.id} component={component} citation={citation} />
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

export function UnityDiffView(props: { diff: UnityDiff; path: string; raw: ReactNode }) {
  return <UnityInspector {...props} />;
}
export function UnityCitationView({
  citation,
  ...props
}: {
  citation: UnityCitation;
  path: string;
  raw: ReactNode;
}) {
  return <UnityInspector diff={citation} citation {...props} />;
}
