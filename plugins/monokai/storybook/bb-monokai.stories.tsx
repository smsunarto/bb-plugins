import type { CSSProperties, ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

type TokenStyle = CSSProperties & Record<`--${string}`, string>;

const meta = {
  title: "Theme/bb Monokai",
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function tokenStyle(values: Record<`--${string}`, string>): TokenStyle {
  return values;
}

function Swatch({ label, token }: { label: string; token: string }) {
  return (
    <article className="sb-swatch" style={tokenStyle({ "--swatch": `var(${token})` })}>
      <span className="sb-token-name">{label}</span>
      <p>{token}</p>
    </article>
  );
}

function Page({
  kicker,
  title,
  description,
  children,
}: {
  kicker: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="sb-page">
      <span className="sb-kicker">{kicker}</span>
      <h1>{title}</h1>
      <p>{description}</p>
      {children}
    </div>
  );
}

export const Foundations: Story = {
  name: "Foundations",
  render: () => (
    <Page
      kicker="Design contract"
      title="One meaning per hue"
      description="The real bb Monokai stylesheet supplies every value. These fixtures only map its semantic tokens to visible roles."
    >
      <section className="sb-section">
        <h2>Grounds ramp</h2>
        <div className="sb-grid">
          <Swatch label="Chrome" token="--card" />
          <Swatch label="Editor" token="--background" />
          <Swatch label="Well" token="--surface-recessed-solid" />
          <Swatch label="Raised" token="--surface-raised-solid" />
          <Swatch label="Selection" token="--muted" />
        </div>
      </section>

      <section className="sb-section">
        <h2>Text ladder</h2>
        <div className="sb-text-ladder">
          <p className="sb-foreground">Primary · --foreground · The action and its outcome.</p>
          <p className="sb-muted-foreground">Secondary · --muted-foreground · Supporting context.</p>
          <p className="sb-readback-foreground">Muted · --readback-foreground · Readback and metadata.</p>
          <p className="sb-subtle-foreground">Faint · --subtle-foreground · Where, not what.</p>
        </div>
      </section>

      <section className="sb-section">
        <h2>Accent and feedback</h2>
        <div className="sb-grid">
          <Swatch label="Interactive" token="--primary" />
          <Swatch label="Success / added" token="--success" />
          <Swatch label="Warning / attention" token="--warning" />
          <Swatch label="Danger / removed" token="--destructive" />
          <Swatch label="Merged" token="--pr-merged" />
        </div>
      </section>

      <section className="sb-section">
        <h2>Borders</h2>
        <div className="sb-borders">
          {[
            ["Seam", "--border-seam"],
            ["Default", "--border"],
            ["Hairline", "--border-hairline"],
            ["Focus", "--ring"],
          ].map(([label, token]) => (
            <div
              className="sb-border-sample"
              key={token}
              style={tokenStyle({ "--sample-border": `var(${token})` })}
            >
              {label} · {token}
            </div>
          ))}
        </div>
      </section>
    </Page>
  ),
};

export const ChromeAndStates: Story = {
  name: "Chrome and states",
  render: () => (
    <Page
      kicker="Application fixtures"
      title="Chrome and states"
      description="The markup carries bb's real selector hooks where the theme targets them. Neutral fixture CSS supplies layout only."
    >
      <section className="sb-section">
        <div className="sb-app-shell">
          <aside className="sb-sidebar">
            <strong>bb Monokai</strong>
            <div className="sb-sidebar-list">
              <div className="sb-sidebar-row">Default thread</div>
              <div className="sb-sidebar-row is-selected">Selected thread</div>
              <div className="sb-sidebar-row">Hover this row</div>
            </div>
          </aside>

          <div className="sb-main">
            <div>
              <div className="sb-agent-card rounded-xl border border-border-seam bg-surface-recessed">
                <span className="sb-label">Active agent surface</span>
                <h2>Review the palette contract</h2>
                <p className="sb-muted-foreground">A quiet editor-ground panel with a faint ladder edge.</p>
              </div>

              <div className="sb-controls">
                <button className="sb-button bg-primary" type="button">Primary action</button>
                <button className="sb-button bg-secondary" type="button">Secondary</button>
                <input className="sb-field border-input" defaultValue="Focused field" aria-label="Theme field" />
                <span className="sb-pill"><span style={{ color: "var(--pill-icon)" }}>@</span>theme</span>
                <span className="sb-tooltip bg-primary"><span role="tooltip">Neutral tooltip</span></span>
              </div>
            </div>

            <div className="sb-promptbox" data-promptbox>
              <textarea
                className="sb-field border-input"
                aria-label="Prompt"
                defaultValue="Create a visual catalog for this theme."
              />
              <div className="sb-prompt-actions">
                <button
                  className="sb-stop"
                  data-promptbox-submit-action
                  aria-label="Stop run"
                  type="button"
                >
                  ■
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </Page>
  ),
};

const ansiSlots = Array.from({ length: 16 }, (_, index) => index);

export const ContentPalettes: Story = {
  name: "Content palettes",
  render: () => (
    <Page
      kicker="Program-owned color"
      title="Content palettes"
      description="ANSI, code, diff, and tree colors keep content semantics separate from the single chrome accent."
    >
      <section className="sb-section">
        <h2>Terminal ANSI</h2>
        <div className="sb-ansi-grid">
          {ansiSlots.map((index) => (
            <div
              className="sb-ansi"
              key={index}
              style={tokenStyle({
                "--ansi-bg": `var(--ansi-${index})`,
                "--ansi-fg": `var(--ansi-bg-fg-${index})`,
              })}
            >
              ANSI {index}
            </div>
          ))}
        </div>
      </section>

      <section className="sb-section">
        <h2>Inline code</h2>
        <pre className="sb-code bb-code-highlight"><code><span style={{ color: "var(--sh-keyword)" }}>const</span>{" "}<span style={{ color: "var(--sh-identifier)" }}>theme</span>{" "}<span style={{ color: "var(--sh-sign)" }}>=</span>{" "}<span style={{ color: "var(--sh-entity)" }}>definePalette</span><span style={{ color: "var(--sh-sign)" }}>(</span><span style={{ color: "var(--sh-string)" }}>"monokai"</span><span style={{ color: "var(--sh-sign)" }}>)</span>;
<span style={{ color: "var(--sh-comment)" }}>{"// One meaning per hue."}</span></code></pre>
      </section>

      <section className="sb-section">
        <h2>Diff states</h2>
        <div className="sb-diff">
          <div className="sb-diff-row">
            <span className="sb-diff-number">18</span>
            <span className="sb-diff-code">const surface = "context";</span>
          </div>
          <div
            className="sb-diff-row"
            style={tokenStyle({
              "--diff-bg": "var(--diffs-bg-addition-override)",
              "--diff-number-bg": "var(--diffs-bg-addition-number-override)",
              "--diff-number-fg": "var(--diffs-fg-number-addition-override)",
            })}
          >
            <span className="sb-diff-number">19</span>
            <span className="sb-diff-code">+ const added = "success";</span>
          </div>
          <div
            className="sb-diff-row"
            style={tokenStyle({
              "--diff-bg": "var(--diffs-bg-deletion-override)",
              "--diff-number-bg": "var(--diffs-bg-deletion-number-override)",
              "--diff-number-fg": "var(--diffs-fg-number-deletion-override)",
            })}
          >
            <span className="sb-diff-number">20</span>
            <span className="sb-diff-code">- const removed = "danger";</span>
          </div>
          <div
            className="sb-diff-row"
            style={tokenStyle({
              "--diff-bg": "color-mix(in srgb, var(--diffs-modified-color-override) 14%, transparent)",
            })}
          >
            <span className="sb-diff-number">21</span>
            <span className="sb-diff-code">~ const changed = "attention";</span>
          </div>
        </div>
      </section>

      <section className="sb-section">
        <h2>File tree status</h2>
        <div className="sb-tree">
          {[
            ["new-theme.css", "A", "--trees-status-added-override"],
            ["palette.svg", "M", "--trees-status-modified-override"],
            ["old-theme.css", "D", "--trees-status-deleted-override"],
            ["dist/", "I", "--trees-status-ignored-override"],
          ].map(([file, status, token]) => (
            <div className="sb-tree-row" key={file}>
              <span>{file}</span>
              <span
                className="sb-tree-status"
                style={tokenStyle({ "--tree-status": `var(${token})` })}
              >
                {status}
              </span>
            </div>
          ))}
        </div>
      </section>
    </Page>
  ),
};
