const STYLE_MARKER = "data-bb-simple-notes-styles";
const EDITOR_CSS = `
/* Ported from smsunarto-theme/styles/cursor-markdown-preview.css. */
.bb-simple-notes-editor {
  container-type: inline-size;
  background: #181818;
}
.bb-simple-notes-editor .docs-prose {
  outline: none;
  width: 100%;
  max-width: 700px;
  box-sizing: border-box;
  margin: 0 auto;
  padding: 48px clamp(24px, 4vw, 56px) 96px;
  color: #e3e3dd;
  caret-color: #e3e3dd;
  font-family: "SN Pro", var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 17px;
  font-kerning: normal;
  font-weight: 400;
  letter-spacing: normal;
  line-height: 1.5;
  overflow-wrap: break-word;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
.bb-simple-notes-editor .docs-prose > :first-child,
.bb-simple-notes-editor .docs-prose li > :first-child,
.bb-simple-notes-editor .docs-prose blockquote > :first-child { margin-top: 0; }
.bb-simple-notes-editor .docs-prose p { margin: 1.75rem 0; }
.bb-simple-notes-editor .docs-prose h1,
.bb-simple-notes-editor .docs-prose h2,
.bb-simple-notes-editor .docs-prose h3,
.bb-simple-notes-editor .docs-prose h4,
.bb-simple-notes-editor .docs-prose h5,
.bb-simple-notes-editor .docs-prose h6 {
  border-bottom: 0;
  color: #9ddd54;
  font-family: inherit;
  font-weight: 600;
  padding-bottom: 0;
}
/* Heading scale: 1.5 / 1.25 / 1.1 / 1 em at weight 600, more room above than below. */
.bb-simple-notes-editor .docs-prose h1 { font-size: 1.5em; line-height: 1.2; letter-spacing: -0.02em; margin: 2.5rem 0 1rem; }
.bb-simple-notes-editor .docs-prose h2 { font-size: 1.25em; line-height: 1.25; letter-spacing: -0.015em; margin: 2.25rem 0 0.875rem; }
.bb-simple-notes-editor .docs-prose h3 { font-size: 1.1em; line-height: 1.3; letter-spacing: -0.01em; margin: 1.75rem 0 0.75rem; }
.bb-simple-notes-editor .docs-prose h4 { font-size: 1em; line-height: 1.3; letter-spacing: 0; margin: 1.75rem 0 0.5rem; }
.bb-simple-notes-editor .docs-prose h5 { font-size: 0.85em; line-height: 1.3; margin: 1.75rem 0; font-weight: 500; }
.bb-simple-notes-editor .docs-prose h6 { font-size: 0.8em; line-height: 1.3; margin: 1.75rem 0; font-weight: 500; }
.bb-simple-notes-editor .docs-prose ul,
.bb-simple-notes-editor .docs-prose ol { margin: 1.75rem 0; padding-inline-start: 0; }
.bb-simple-notes-editor .docs-prose ul { list-style: disc; }
.bb-simple-notes-editor .docs-prose ol { list-style: decimal; }
.bb-simple-notes-editor .docs-prose :is(ul, ol) > li { margin-inline-start: 30px; }
.bb-simple-notes-editor .docs-prose ol ol > li,
.bb-simple-notes-editor .docs-prose ul ul > li { margin-inline-start: 32px; }
/* List spacing steps by depth: 0.5em between top-level items, 0.25em between
   nested siblings, 0.25em from a parent item's text to its child list. */
.bb-simple-notes-editor .docs-prose li + li { margin-top: 0.5em; }
.bb-simple-notes-editor .docs-prose li li + li { margin-top: 0.25em; }
.bb-simple-notes-editor .docs-prose li > p { margin: 0; }
.bb-simple-notes-editor .docs-prose li > :is(ul, ol) { margin: 0.25em 0 0; }
.bb-simple-notes-editor .docs-prose li::marker { color: #7c7866; }
.bb-simple-notes-editor .docs-prose strong { color: #51dae9; font-weight: 600; }
.bb-simple-notes-editor .docs-prose em { color: #e3e3ddd6; }
.bb-simple-notes-editor .docs-prose a {
  color: #51dae9;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: currentColor;
  text-decoration-thickness: from-font;
  text-underline-offset: 0.12em;
}
.bb-simple-notes-editor .docs-prose a:hover { color: #75f0ff; }
.bb-simple-notes-editor .docs-prose a:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 0.125em; }
.bb-simple-notes-editor .docs-prose code:has(> a) { background: transparent; border: 0; border-radius: 0; font-family: inherit; font-size: inherit; padding: 0; }
.bb-simple-notes-editor .docs-prose blockquote { border-left: 1px solid #fe5d86; border-radius: 0; color: #e3e3ddbd; margin: 1rem 0; padding: 0 0 0 1.1em; }
.bb-simple-notes-editor .docs-prose :is(code, pre) { font-family: "Berkeley Mono", var(--font-mono, monospace); }
.bb-simple-notes-editor .docs-prose code { color: #e3e3dd; font-size: 0.875em; line-height: 1.5; }
.bb-simple-notes-editor .docs-prose :not(pre) > code { background: #262626; border: 1px solid #e3e3dd1a; border-radius: 4px; box-decoration-break: clone; padding: 0.15em 0.3em; -webkit-box-decoration-break: clone; }
.bb-simple-notes-editor .docs-prose pre {
  background: #1e1e1e;
  border: 0;
  border-radius: 4px;
  box-sizing: border-box;
  font-size: 13px;
  left: 50%;
  line-height: 19.5px;
  margin: 1rem 0;
  max-width: none;
  overflow-x: auto;
  padding: 12.75px 17px;
  position: relative;
  transform: translateX(-50%);
  white-space: pre;
  width: min(calc(100ch + 34px), calc(100cqw - 64px));
  word-break: normal;
}
.bb-simple-notes-editor .docs-prose pre code { background: transparent; border: 0; display: inline-block; font-size: inherit; line-height: inherit; overflow-wrap: normal; padding: 0; white-space: pre; word-break: normal; }
.bb-simple-notes-editor .docs-prose img { display: block; max-width: 100%; max-height: 38rem; margin: 1.75rem auto; border-radius: 4px; border: 1px solid #e3e3dd1a; }
.bb-simple-notes-editor .docs-prose table { width: 100%; border: 0; border-collapse: collapse; border-radius: 0; table-layout: fixed; font-size: 0.875em; line-height: 1.3; }
.bb-simple-notes-editor .docs-prose th,
.bb-simple-notes-editor .docs-prose td { position: relative; min-width: 6rem; border: 0; border-bottom: 1px solid #e3e3dd11; padding: 0.25em 0.625em 0.25em 0; text-align: left; vertical-align: top; }
.bb-simple-notes-editor .docs-prose th { font-weight: 600; }
.bb-simple-notes-editor .docs-prose :is(th, td) > p { margin-top: 0; }
.bb-simple-notes-editor .docs-prose :is(th, td) > p + p { margin-top: 0.65em; }
.bb-simple-notes-editor .docs-prose hr { border: 0; border-top: 1px solid #e3e3dd11; margin: 1.75rem 0; }
.bb-simple-notes-editor .docs-prose ::selection { background: #404040; }
.simple-html-embed { margin:1.75rem 0; overflow:hidden; border:1px solid #e3e3dd1a; border-radius:4px; background:#1e1e1e; }
.simple-html-embed-header { border-bottom:1px solid #e3e3dd11; background:#262626; padding:.45rem .7rem; color:#e3e3ddbd; font:11px "Berkeley Mono",var(--font-mono,monospace); }
.simple-html-embed iframe { display:block; width:100%; border:0; background:white; }
.bb-docs-panel .docs-prose { max-width: none; padding: 1rem 0 3rem; font-size: 14px; }
@media (max-width: 47.999rem) { .bb-simple-notes-editor .docs-prose { padding-inline: 1.25rem; font-size: 17px; } }
.docs-mdx-editor.docs-mdx-editor {
  --basePageBg: var(--background);
  --baseBase: var(--background);
  --baseBgSubtle: var(--card);
  --baseBg: var(--muted);
  --baseBgHover: var(--accent);
  --baseBgActive: var(--accent);
  --baseLine: var(--border);
  --baseBorder: var(--border);
  --baseBorderHover: var(--ring);
  --baseSolid: var(--muted-foreground);
  --baseSolidHover: var(--foreground);
  --baseText: var(--muted-foreground);
  --baseTextContrast: var(--foreground);
  --accentBase: var(--background);
  --accentBgSubtle: var(--muted);
  --accentBg: var(--accent);
  --accentBgHover: var(--accent);
  --accentBgActive: var(--accent);
  --accentLine: var(--border);
  --accentBorder: var(--ring);
  --accentBorderHover: var(--ring);
  --accentSolid: var(--primary);
  --accentSolidHover: var(--primary);
  --accentText: var(--primary);
  --accentTextContrast: var(--foreground);
  color: var(--foreground);
  font-family: var(--font-sans, sans-serif);
}
.docs-mdx-editor [role="toolbar"] {
  position: sticky;
  top: 0;
  z-index: 10;
  flex-wrap: wrap;
  border-radius: 0;
  border-bottom: 1px solid var(--border);
  background: var(--background);
}
.docs-mdx-editor .docs-prose [role="checkbox"] { margin-inline-start: 0; }
.docs-mdx-editor .docs-prose [data-lexical-decorator="true"] { white-space: normal; }
.docs-mdx-editor .docs-prose .canvas-document { padding: 0; max-width: none; font-size: 14px; }
.docs-mdx-editor .cm-editor { background: var(--background); color: var(--foreground); }
.docs-mdx-editor .cm-gutters { background: var(--muted); color: var(--muted-foreground); border-color: var(--border); }
.docs-mdx-editor .cm-content { caret-color: var(--foreground); }
.docs-mdx-editor .cm-cursor { border-left-color: var(--foreground); }

`;

export function ensureEditorStyles(): void {
  const existing = document.head.querySelector<HTMLStyleElement>(`[${STYLE_MARKER}]`);
  if (existing) {
    existing.textContent = EDITOR_CSS;
    return;
  }
  const style = document.createElement("style");
  style.setAttribute(STYLE_MARKER, "");
  style.textContent = EDITOR_CSS;
  document.head.append(style);
}
