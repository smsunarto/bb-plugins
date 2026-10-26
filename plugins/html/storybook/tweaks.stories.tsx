import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { TweakPanel } from "../src/app/tweak-panel.tsx";
import "../src/app/app.css";
import {
  PreviewActions,
  PreviewHeader,
  PreviewSurface,
} from "../src/app/components/preview-surface.tsx";

function ReleasePreview({
  groups,
  original,
}: Pick<ComponentProps<typeof TweakPanel>, "groups" | "original">) {
  const value = (id: string) => {
    const control = groups.flatMap((group) => group.controls).find((control) => control.id === id);
    return original ? control?.initialValue : control?.value;
  };
  const escape = (input: string) =>
    input.replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character] ?? character,
    );
  const theme = getComputedStyle(document.documentElement);
  const color = (name: string) => escape(theme.getPropertyValue(name).trim());
  const height = Number(value("size")) || 24;
  const labelSize = Number(value("label-size")) || 13;
  const rows =
    value("palette") === "status"
      ? [
          ["In review", 78],
          ["Ready", 92],
          ["In progress", 61],
        ]
      : value("palette") === "priority"
        ? [
            ["Release blockers", 92],
            ["High priority", 78],
            ["Improvements", 61],
          ]
        : [
            ["Platform", 92],
            ["Desktop", 78],
            ["Developer experience", 61],
          ];
  const accent = typeof value("accent") === "string" ? String(value("accent")) : color("--primary");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;padding:32px;background:${color("--background")};color:${color("--foreground")};font:13px system-ui,sans-serif}
    h1{margin:0 0 8px;font-size:20px}p{margin:0 0 32px;color:${color("--muted-foreground")};line-height:1.5}
    .row{margin:0 0 24px}.label{display:flex;justify-content:space-between;margin-bottom:8px;font-size:${labelSize}px}
    .track{position:relative;height:${height}px;background:${color("--muted")};border-radius:4px;overflow:hidden}
    .fill{height:100%;background:${escape(accent)};border-radius:4px}.target{position:absolute;inset:0 auto 0 80%;border-left:2px dashed ${color("--foreground")}}
    footer{padding-top:20px;border-top:1px solid ${color("--border")};color:${color("--muted-foreground")}}
    </style></head><body><h1>Autumn release readiness</h1><p>Completed release checks by ${escape(String(value("palette") ?? "team"))}. Target: 80% before the release candidate.</p>
    ${rows.map(([label, percent]) => `<div class="row"><div class="label"><span>${label}</span>${value("totals") !== false ? `<span>${percent}%</span>` : ""}</div><div class="track"><div class="fill" style="width:${percent}%"></div>${value("grid") !== false ? '<span class="target"></span>' : ""}</div></div>`).join("")}
    <footer>Release candidate · 24 October</footer></body></html>`;
  return (
    <iframe
      title="Release readiness preview"
      className="html-page-frame"
      srcDoc={html}
      sandbox=""
      style={{ height: 440 }}
    />
  );
}

function TweakWorkspace({
  preview,
  panel,
  visible,
  hasTweaks,
  initialWide,
  onToggle,
}: {
  preview: ReactNode;
  panel: ReactNode;
  visible: boolean;
  hasTweaks: boolean;
  initialWide: boolean;
  onToggle: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const wideTrigger = useRef<HTMLButtonElement>(null);
  const [wide, setWide] = useState(initialWide);
  const [expanded, setExpanded] = useState(true);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = dialog.current;
      if (!element?.isConnected) return;
      if (element.open) element.close();
      if (wide) element.showModal();
      else element.setAttribute("open", "");
    });
    return () => cancelAnimationFrame(frame);
  }, [wide, expanded]);
  const leaveWide = () => {
    dialog.current?.close();
    setWide(false);
    wideTrigger.current?.focus({ preventScroll: true });
  };
  const actions = (
    <PreviewActions
      hasTweaks={hasTweaks}
      canShareState={false}
      tweakOpen={visible}
      saving={false}
      onTweak={onToggle}
      onShare={() => {}}
    />
  );
  return (
    <figure className="html-page-card">
      <PreviewHeader
        label="Release readiness"
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        onWide={expanded ? () => setWide(true) : undefined}
        wideTrigger={wideTrigger}
      />
      {expanded && (
        <>
          {hasTweaks && <div className="html-page-toolbar">{actions}</div>}
          <PreviewSurface
            dialogRef={dialog}
            wide={wide}
            label="Release readiness"
            onLeaveWide={leaveWide}
            actions={actions}
            preview={preview}
            panel={panel}
            showPanel={visible && hasTweaks}
          />
        </>
      )}
    </figure>
  );
}

function InteractiveTweaks({
  initialWide,
  ...args
}: ComponentProps<typeof TweakPanel> & { initialWide: boolean }) {
  const [groups, setGroups] = useState(args.groups);
  const [original, setOriginal] = useState(args.original);
  const [visible, setVisible] = useState(true);
  const inEditor = document.documentElement.dataset.bbNativePreview === "loaded";
  const panel = (
    <TweakPanel
      {...args}
      groups={groups}
      original={original}
      onOriginal={setOriginal}
      onClose={() => {
        args.onClose();
        setVisible(false);
      }}
      onReset={() => setGroups(args.groups)}
      onChange={(groupId, controlId, value) => {
        args.onChange(groupId, controlId, value);
        setGroups((current) =>
          current.map((group) =>
            group.id !== groupId
              ? group
              : {
                  ...group,
                  controls: group.controls.map((control) =>
                    control.id !== controlId
                      ? control
                      : control.type === "slider" && typeof value === "number"
                        ? { ...control, value }
                        : control.type === "toggle" && typeof value === "boolean"
                          ? { ...control, value }
                          : (control.type === "color" || control.type === "select") &&
                              typeof value === "string"
                            ? { ...control, value }
                            : control,
                  ),
                },
          ),
        );
      }}
    />
  );
  return inEditor ? (
    <TweakWorkspace
      preview={<ReleasePreview groups={groups} original={original} />}
      panel={panel}
      visible={visible}
      hasTweaks={groups.length > 0}
      initialWide={initialWide}
      onToggle={() => setVisible(!visible)}
    />
  ) : (
    panel
  );
}
const meta = {
  render: (args, context) => (
    <InteractiveTweaks {...args} initialWide={context.viewMode !== "docs"} />
  ),
  play: ready,
  title: "Components/HTML/Tweak panel",
  component: TweakPanel,
  parameters: {
    editorContext: { placement: "message", title: "Visualization" },
  },
  tags: ["autodocs"],
  args: {
    groups: [
      {
        id: "appearance",
        title: "Release progress chart",
        visible: true,
        variant: null,
        controls: [
          {
            id: "size",
            type: "slider",
            label: "Bar height",
            value: 24,
            initialValue: 24,
            min: 12,
            max: 48,
            step: 1,
            unit: "px",
          },
          {
            id: "grid",
            type: "toggle",
            label: "Show target line",
            value: true,
            initialValue: true,
          },
          {
            id: "palette",
            type: "select",
            label: "Group by",
            value: "team",
            initialValue: "team",
            options: [
              { value: "team", label: "Team" },
              { value: "status", label: "Status" },
              { value: "priority", label: "Priority" },
            ],
          },
        ],
      },
      {
        id: "annotations",
        title: "Labels and annotations",
        visible: true,
        variant: "Compact",
        controls: [
          {
            id: "totals",
            type: "toggle",
            label: "Show completed totals",
            value: true,
            initialValue: true,
          },
          {
            id: "accent",
            type: "color",
            label: "Highlight color",
            value: "#88c0d0",
            initialValue: "#88c0d0",
          },
          {
            id: "label-size",
            type: "slider",
            label: "Label size",
            value: 13,
            initialValue: 13,
            min: 11,
            max: 18,
            step: 1,
            unit: "px",
          },
        ],
      },
    ],
    original: false,
    saving: false,
    readOnly: false,
    onChange: fn(),
    onReset: fn(),
    onOriginal: fn(),
    onApply: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof TweakPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Editable: Story = {};
export const Saving: Story = { args: { saving: true } };
export const ReadOnly: Story = { args: { readOnly: true } };
export const Original: Story = { args: { original: true } };
export const Empty: Story = { args: { groups: [] } };
/** A fenced block's preview adjusts live but has no saved state to add to chat. */
export const Unsaved: Story = { args: { onApply: undefined } };
