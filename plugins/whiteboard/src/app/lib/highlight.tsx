import {
  type PluginCodeThemeData,
  experimental_useCodeTheme as useCodeTheme,
} from "@get-bb/plugin-sdk/app";
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  createContext,
  createElement,
  useContext,
  useMemo,
} from "react";
import { type HighlighterCore, type ThemedToken, createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import c from "shiki/langs/c.mjs";
import csharp from "shiki/langs/csharp.mjs";
import css from "shiki/langs/css.mjs";
import diff from "shiki/langs/diff.mjs";
import docker from "shiki/langs/docker.mjs";
import go from "shiki/langs/go.mjs";
import html from "shiki/langs/html.mjs";
import ini from "shiki/langs/ini.mjs";
import java from "shiki/langs/java.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsonc from "shiki/langs/jsonc.mjs";
import kotlin from "shiki/langs/kotlin.mjs";
import lua from "shiki/langs/lua.mjs";
import make from "shiki/langs/make.mjs";
import markdown from "shiki/langs/markdown.mjs";
import proto from "shiki/langs/proto.mjs";
import python from "shiki/langs/python.mjs";
import rust from "shiki/langs/rust.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import sql from "shiki/langs/sql.mjs";
import swift from "shiki/langs/swift.mjs";
import toml from "shiki/langs/toml.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import xml from "shiki/langs/xml.mjs";
import yaml from "shiki/langs/yaml.mjs";
import zig from "shiki/langs/zig.mjs";

/*
 * Shiki highlighting for Whiteboard code, in bb's live code theme (bb Monokai
 * Code under bb Monokai): the theme document bb's own highlighter renders
 * from, so code here matches bb's code views and follows theme switches. The
 * blocks take the theme's ground, so they stay dark on the always-light canvas.
 *
 * The app bundles as one file, so the grammars are a fixed static set. Large or
 * rare grammars stay out: C++, PHP and Ruby (which embeds C++) would add
 * ~700 KB. Any other language renders as plain text. The JavaScript regex
 * engine keeps highlighting synchronous: no WebAssembly, and no unhighlighted
 * first frame.
 */

const JSX_ALIASES = { jsx: "tsx" };

let highlighter: HighlighterCore | undefined;
let languages: Set<string> | undefined;

function load(): { highlighter: HighlighterCore; languages: Set<string> } {
  highlighter ??= createHighlighterCoreSync({
    themes: [],
    // prettier-ignore
    langs: [c, csharp, css, diff, docker, go, html, ini, java, javascript, json, jsonc, kotlin, lua, make, markdown, proto, python, rust, shellscript, sql, swift, toml, tsx, typescript, xml, yaml, zig],
    // TSX covers JSX, so its own 190 KB grammar stays out.
    langAlias: JSX_ALIASES,
    engine: createJavaScriptRegexEngine(),
  });
  languages ??= new Set([...highlighter.getLoadedLanguages(), ...Object.keys(JSX_ALIASES)]);

  return { highlighter, languages };
}

/** Above this, tokenizing would block the frame for too long; the code renders plain. */
const MAX_HIGHLIGHT_LENGTH = 100_000;

export interface HighlightedCode {
  /** Spans whose text is exactly the code, or the code itself. */
  content: ReactNode;
  /** The theme's ground and ink for the block; unset until bb resolves a theme. */
  style?: CSSProperties;
}

const CodeThemeContext = createContext<PluginCodeThemeData | null>(null);

/** Gives the code below it bb's current code theme. */
export function CodeThemeProvider({ children }: { children: ReactNode }) {
  const { theme } = useCodeTheme();

  return <CodeThemeContext.Provider value={theme}>{children}</CodeThemeContext.Provider>;
}

/**
 * `code` highlighted in the provider's theme. `language` is a fence info string
 * or a Shiki name or alias (`ts`, `py`, `sh`, `yml`, ...), in any case. An
 * unknown language renders plain on the theme's ground. Without a theme
 * (outside the provider, or before bb resolves one) the code renders plain.
 */
export function useHighlightedCode(code: string, language: string | null | undefined) {
  const theme = useContext(CodeThemeContext);

  return useMemo(() => highlightCode(code, language, theme), [code, language, theme]);
}

let loadedTheme: PluginCodeThemeData | undefined;

function highlightCode(
  code: string,
  language: string | null | undefined,
  theme: PluginCodeThemeData | null,
): HighlightedCode {
  if (!theme) return { content: code };

  // Every block takes the theme's ground, highlighted or not, so they match.
  const style = {
    background: theme.bg,
    color: theme.fg,
    "--wb-code-bg": theme.bg,
    "--wb-code-fg": theme.fg,
    "--wb-code-line-number": theme.colors["editorLineNumber.foreground"],
  } as CSSProperties;
  const lang = language?.trim().toLowerCase();
  if (!lang || code.length > MAX_HIGHLIGHT_LENGTH) return { content: code, style };

  const loaded = load();
  if (!loaded.languages.has(lang)) return { content: code, style };

  // One theme is live at a time. Loading it under its name replaces an older
  // document of the same name, so an edited theme takes effect too.
  if (theme !== loadedTheme) {
    loaded.highlighter.loadThemeSync({
      ...theme,
      colors: { ...theme.colors },
      tokenColors: theme.tokenColors.map((rule) => ({
        scope: typeof rule.scope === "string" ? rule.scope : rule.scope && [...rule.scope],
        settings: { ...rule.settings },
      })),
    });
    loadedTheme = theme;
  }

  const { tokens } = loaded.highlighter.codeToTokens(code, { lang, theme: theme.name });
  // Spread children are static, so the spans need no keys.
  const nodes: ReactNode[] = [];
  for (const [index, line] of tokens.entries()) {
    if (index > 0) nodes.push("\n");
    for (const token of line) nodes.push(renderToken(token, theme.fg));
  }

  return { content: createElement(Fragment, null, ...nodes), style };
}

// TextMate font style bits (`FontStyle` in vscode-textmate).
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

function renderToken(token: ThemedToken, fg: string): ReactNode {
  const fontStyle = Math.max(token.fontStyle ?? 0, 0);
  const color = token.color?.toLowerCase() === fg.toLowerCase() ? undefined : token.color;
  if (!color && !fontStyle) return token.content;

  return (
    <span
      style={{
        color,
        fontStyle: fontStyle & ITALIC ? "italic" : undefined,
        fontWeight: fontStyle & BOLD ? 700 : undefined,
        textDecoration: fontStyle & UNDERLINE ? "underline" : undefined,
      }}
    >
      {token.content}
    </span>
  );
}
