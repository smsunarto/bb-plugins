/**
 * The page contract shared by the server, which prepares and stores pages, and
 * the app, which frames them. Ported from T3 Code's `packages/shared/src/htmlRender.ts`
 * (pingdotgg/t3code @ cc0b86d) with T3's palette replaced by bb's theme tokens.
 */

export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2000;
// A client fits the frame to the live page up to this height. It only stops a
// page that grows with its frame, since vh units are rejected at publish.
export const HTML_RENDER_MAX_FIT_HEIGHT = 20_000;
export const HTML_RENDER_MAX_TITLE_LENGTH = 200;
export const HTML_RENDER_MAX_HTML_LENGTH = 512_000;
export const HTML_RENDER_COLUMN_WIDTH = 712;

/** The message directive `html_render` returns and the app renders. */
export const HTML_RENDER_DIRECTIVE = "html-render";
const PAGE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function isHtmlRenderPageId(value: unknown): value is string {
  return typeof value === "string" && PAGE_ID_PATTERN.test(value);
}

export interface HtmlRenderReference {
  readonly id: string;
  readonly title: string;
  readonly height: number;
}

// Directive attribute values are double-quoted and cannot escape.
const directiveText = (value: string) =>
  value
    .replace(/["\\{}\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The directive carries the title and height so a client can reserve the
 * frame and load the page without asking the server first.
 */
export function htmlRenderDirective(reference: HtmlRenderReference): string {
  const title = directiveText(reference.title) || "HTML";
  return `::${HTML_RENDER_DIRECTIVE}{id="${reference.id}" title="${title}" height="${clampHtmlRenderHeight(reference.height)}"}`;
}

/** Parses untrusted directive attributes. */
export function readHtmlRenderDirective(
  attributes: Readonly<Record<string, string>>,
): HtmlRenderReference | undefined {
  const { id, title, height } = attributes;
  if (!isHtmlRenderPageId(id)) return undefined;
  const parsed = Number(height);
  return {
    id,
    title: directiveText(title ?? "").slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML",
    height: clampHtmlRenderHeight(Number.isFinite(parsed) ? parsed : HTML_RENDER_MIN_HEIGHT * 4),
  };
}

/** The plugin HTTP path and query a stored page is served from. */
export const HTML_RENDER_PAGE_PATH = "/page";

export function htmlRenderPagePath(id: string): string {
  return `${HTML_RENDER_PAGE_PATH}?id=${encodeURIComponent(id)}`;
}

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));
}

/**
 * A page even a few pixels taller than its frame scrolls inside it and takes
 * the reader's scroll, so the frame fits the page once the page reports its
 * height. Until then the agent's height holds the space.
 */
export function htmlRenderFrameHeight(height: number, contentHeight?: number): number {
  if (contentHeight === undefined) return clampHtmlRenderHeight(height);
  return Math.min(
    HTML_RENDER_MAX_FIT_HEIGHT,
    Math.max(HTML_RENDER_MIN_HEIGHT, Math.ceil(contentHeight)),
  );
}

export function htmlRenderFileName(title: string): string {
  const name = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return `${name || "Page"}.html`;
}

export type ThemeAppearance = "dark" | "light";

export interface HtmlRenderTheme {
  readonly appearance: ThemeAppearance;
  readonly variables: Readonly<Record<string, string>>;
}

/** The bb tokens a page's variables are built from. */
export const BB_THEME_TOKENS = [
  "--background",
  "--foreground",
  "--muted",
  "--muted-foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--secondary",
  "--secondary-foreground",
  "--border",
  "--input",
  "--ring",
  "--primary",
  "--primary-foreground",
  "--timeline-accent",
  "--destructive",
  "--destructive-text",
  "--surface-destructive",
  "--warning",
  "--warning-text",
  "--success",
  "--success-foreground",
  "--ansi-1",
  "--ansi-2",
  "--ansi-3",
  "--ansi-4",
  "--ansi-5",
  "--ansi-6",
  "--radius",
  "--font-sans",
  "--font-mono",
] as const;

export type BbThemeToken = (typeof BB_THEME_TOKENS)[number];
export type BbThemeTokens = Readonly<Record<BbThemeToken, string>>;

export interface HtmlRenderFonts {
  readonly sans: string;
  readonly mono: string;
}

export const HTML_RENDER_DEFAULT_FONTS: HtmlRenderFonts = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  // Concrete names only: some engines alias `ui-monospace` to the proportional UI font.
  mono: '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
};

/** Arial-metric substitutes keep measured wrapping close to client system fonts. */
export const HTML_RENDER_MEASURE_FONTS: HtmlRenderFonts = {
  sans: '"Liberation Sans", Arimo, Arial, Helvetica, sans-serif',
  mono: '"Liberation Mono", Cousine, Menlo, Consolas, monospace',
};

const mix = (color: string, percent: number, base: string) =>
  `color-mix(in oklch, ${color} ${percent}%, ${base})`;

// bb's default palette (apps/app/src/components/ui/theme.css), with its ink-over-canvas mixes spelled out.
const DEFAULT_PALETTES = {
  dark: {
    canvas: "oklch(0.195 0 0)",
    ink: "oklch(0.81 0 0)",
    muted: 16,
    secondary: 13,
    border: 19.4,
    input: 32.6,
    mutedForeground: "oklch(0.78 0 0)",
    primary: "oklch(0.82 0 0)",
    primaryForeground: "oklch(0.2178 0 0)",
    accent: "oklch(0.72 0.09 250)",
    destructive: "oklch(0.56 0.19 22.1703)",
    destructiveText: "oklch(0.65 0.16 22)",
    warning: "oklch(0.75 0.16 50)",
    warningText: "oklch(0.75 0.16 50)",
    success: "oklch(0.74 0.15 155)",
    ansi: ["#d85e5e", "#0dbc79", "#e5e510", "#3c88dc", "#c85ac8", "#11a8cd"],
  },
  light: {
    canvas: "oklch(1 0 0)",
    ink: "oklch(0.3211 0 0)",
    muted: 11,
    secondary: 8,
    border: 14,
    input: 29.5,
    mutedForeground: "oklch(0.44 0 0)",
    primary: "oklch(0.27 0 0)",
    primaryForeground: "oklch(1 0 0)",
    accent: "oklch(0.55 0.1 250)",
    destructive: "oklch(0.45 0.19 25.8625)",
    destructiveText: "oklch(0.45 0.19 25.8625)",
    warning: "oklch(0.7 0.16 50)",
    warningText: "oklch(0.55 0.14 50)",
    success: "oklch(0.7 0.15 155)",
    ansi: ["#a11616", "#13704a", "#7f6a00", "#1f5ca6", "#8a2f8a", "#0b6f88"],
  },
} as const;

function defaultTokens(palette: (typeof DEFAULT_PALETTES)[ThemeAppearance]): BbThemeTokens {
  const { canvas, ink, ansi } = palette;
  return {
    "--background": canvas,
    "--foreground": ink,
    "--muted": mix(ink, palette.muted, canvas),
    "--muted-foreground": palette.mutedForeground,
    "--card": canvas,
    "--card-foreground": ink,
    "--popover": canvas,
    "--popover-foreground": ink,
    "--secondary": mix(ink, palette.secondary, canvas),
    "--secondary-foreground": ink,
    "--border": mix(ink, palette.border, canvas),
    "--input": mix(ink, palette.input, canvas),
    "--ring": palette.primary,
    "--primary": palette.primary,
    "--primary-foreground": palette.primaryForeground,
    "--timeline-accent": palette.accent,
    "--destructive": palette.destructive,
    "--destructive-text": palette.destructiveText,
    "--surface-destructive": mix(palette.destructive, 14, "transparent"),
    "--warning": palette.warning,
    "--warning-text": palette.warningText,
    "--success": palette.success,
    "--success-foreground": mix(palette.success, 45, ink),
    "--ansi-1": ansi[0],
    "--ansi-2": ansi[1],
    "--ansi-3": ansi[2],
    "--ansi-4": ansi[3],
    "--ansi-5": ansi[4],
    "--ansi-6": ansi[5],
    "--radius": "0.5rem",
    "--font-sans": HTML_RENDER_DEFAULT_FONTS.sans,
    "--font-mono": HTML_RENDER_DEFAULT_FONTS.mono,
  };
}

/** bb's default theme, used where no client theme is available. */
export const BB_DEFAULT_THEME_TOKENS: Readonly<Record<ThemeAppearance, BbThemeTokens>> = {
  dark: defaultTokens(DEFAULT_PALETTES.dark),
  light: defaultTokens(DEFAULT_PALETTES.light),
};

/**
 * Maps bb's tokens onto the page variables the agent prompt names. `--accent`
 * is the brand color rather than a neutral hover surface, so it follows bb's
 * timeline accent; status `-foreground` variables are text in that hue.
 */
export function htmlRenderTheme(
  tokens: Partial<BbThemeTokens>,
  appearance: ThemeAppearance,
  fonts?: HtmlRenderFonts,
): HtmlRenderTheme {
  const fallback = BB_DEFAULT_THEME_TOKENS[appearance];
  const token = (name: BbThemeToken) => tokens[name]?.trim() || fallback[name];
  const accent = token("--timeline-accent");
  const warning = token("--warning");
  return {
    appearance,
    variables: {
      "--background": token("--background"),
      "--foreground": token("--foreground"),
      "--muted": token("--muted"),
      "--muted-foreground": token("--muted-foreground"),
      "--card": token("--card"),
      "--card-foreground": token("--card-foreground"),
      "--popover": token("--popover"),
      "--popover-foreground": token("--popover-foreground"),
      "--secondary": token("--secondary"),
      "--secondary-foreground": token("--secondary-foreground"),
      "--border": token("--border"),
      "--input": token("--input"),
      "--ring": token("--ring"),
      "--primary": token("--primary"),
      "--primary-foreground": token("--primary-foreground"),
      "--accent": accent,
      "--accent-foreground": token("--primary-foreground"),
      "--accent-surface": mix(accent, 14, "transparent"),
      "--accent-surface-foreground": token("--foreground"),
      "--destructive": token("--destructive"),
      "--destructive-foreground": token("--destructive-text"),
      "--destructive-surface": token("--surface-destructive"),
      "--warning": warning,
      "--warning-foreground": token("--warning-text"),
      "--warning-surface": mix(warning, 14, "transparent"),
      "--success": token("--success"),
      "--success-foreground": token("--success-foreground"),
      "--info": token("--ansi-4"),
      "--info-foreground": token("--ansi-4"),
      "--code-background": token("--muted"),
      "--code-foreground": token("--foreground"),
      "--chart-1": accent,
      "--chart-2": token("--ansi-6"),
      "--chart-3": token("--ansi-3"),
      "--chart-4": token("--ansi-5"),
      "--chart-5": token("--ansi-1"),
      "--chart-6": token("--ansi-2"),
      "--radius": token("--radius"),
      "--font-sans": fonts?.sans ?? token("--font-sans"),
      "--font-mono": fonts?.mono ?? token("--font-mono"),
    },
  };
}

const HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
const OPEN_LINK_METHOD = "ui/open-link";
const SIZE_CHANGED_METHOD = "ui/notifications/size-changed";
const OPEN_IMAGE_METHOD = "html/notifications/open-image";

function readMessage(data: unknown, method: string) {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as Record<string, unknown>;
  if (message.jsonrpc !== "2.0" || message.method !== method) return undefined;
  return typeof message.params === "object" && message.params !== null
    ? { id: message.id, params: message.params as Record<string, unknown> }
    : undefined;
}

export function readHtmlRenderContentHeight(data: unknown): number | undefined {
  const height = readMessage(data, SIZE_CHANGED_METHOD)?.params.height;
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : undefined;
}

export function readHtmlRenderLinkRequest(
  data: unknown,
): { readonly id: string | number; readonly url: string } | undefined {
  const message = readMessage(data, OPEN_LINK_METHOD);
  const id = message?.id;
  const url = message?.params.url;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  return typeof url === "string" && /^https?:\/\//i.test(url) ? { id, url } : undefined;
}

/** Published local images arrive as `data:image/` URLs. */
export function readHtmlRenderImageRequest(
  data: unknown,
): { readonly src: string; readonly name: string } | undefined {
  const params = readMessage(data, OPEN_IMAGE_METHOD)?.params;
  const { src, name } = params ?? {};
  if (typeof src !== "string" || !/^(?:https?:\/\/|data:image\/)/i.test(src)) return undefined;
  const label = typeof name === "string" ? name.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) : "";
  return { src, name: label || "Image" };
}

export function htmlRenderResult(id: string | number) {
  return { jsonrpc: "2.0", id, result: {} } as const;
}

const THEME_FRAGMENT_KEY = "html-theme";

export function htmlRenderThemeFragment(theme: HtmlRenderTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

export function htmlRenderThemeMessage(theme: HtmlRenderTheme) {
  return {
    jsonrpc: "2.0",
    method: HOST_CONTEXT_CHANGED_METHOD,
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  } as const;
}

const BASE_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}" +
  // Focus outlines paint inside the element, so the frame edge never clips them.
  ":where(:focus-visible){outline:2px solid var(--ring)}:focus-visible{outline-width:2px!important;outline-offset:-2px!important}" +
  ":where(img:not(a[href] img,button img)){cursor:zoom-in}";

function rootRule(theme: HtmlRenderTheme): string {
  const declarations = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{color-scheme:${theme.appearance};${declarations}}`;
}

// Apply overridable theme CSS before paint and strip the fragment before routing.
// Links and image clicks go to the host, which opens them outside the sandbox.
const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById("html-theme"),n=0;if(!s)return;var b=${JSON.stringify(BASE_CSS)};function a(t){if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+b;}try{var m=/[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){a(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(e.source===window.parent&&d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&p&&p.styles)a({appearance:p.theme,variables:p.styles.variables});});document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;if(window.parent!==window){e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",id:"html-link-"+(++n),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:u.href}},"*");}else{l.setAttribute("target","_blank");l.setAttribute("rel","noopener");}},true);if(window.parent!==window){var h,o,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED_METHOD)},params:{height:v}},"*");};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);window.addEventListener("click",function(e){var t=e.composedPath()[0],u;if(!e.isTrusted||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||!t||t.tagName!=="IMG"||t.closest("a[href],button"))return;u=t.currentSrc||t.src;if(u)setTimeout(function(){if(!e.defaultPrevented)window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(OPEN_IMAGE_METHOD)},params:{src:u,name:t.alt||t.title||""}},"*");});});}})();`;

function bootstrapMarkup(markup: string): string {
  const dark = htmlRenderTheme(BB_DEFAULT_THEME_TOKENS.dark, "dark");
  const light = htmlRenderTheme(BB_DEFAULT_THEME_TOKENS.light, "light");
  const defaultCss = `${rootRule(dark)}@media (prefers-color-scheme: light){${rootRule(light)}}${BASE_CSS}`;
  return [
    /<meta\s[^>]*charset/i.test(markup.slice(0, 4096)) ? "" : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(markup)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="html-theme">${defaultCss}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
  ].join("");
}

// Blank inert content without shifting offsets so it cannot receive the bootstrap.
const blankNonMarkup = (html: string) => {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => " ".repeat(match.length),
  );
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index;
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length;
      parts.push(scan.slice(at, start), " ".repeat(end - start));
      at = end;
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), " ".repeat(scan.length - start));
    at = scan.length;
  }
  parts.push(scan.slice(at));
  return parts.join("");
};

export function injectHtmlRenderBootstrap(html: string): string {
  const scan = blankNonMarkup(html);
  const markup = bootstrapMarkup(scan);
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}
