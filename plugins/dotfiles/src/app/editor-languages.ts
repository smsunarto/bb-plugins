import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";

/**
 * The languages a dotfiles repository holds, with `@codemirror/language-data`'s
 * names, extensions and filename patterns.
 *
 * bb serves a plugin's app as one file, so that package's dynamic imports
 * bundle all of its ~150 grammars: about 1.2 MB that every client, a phone
 * included, downloads and evaluates at startup, whether or not it opens this
 * editor. Add a language here when the repository gains files in it; a file in
 * any other language opens as plain text.
 */
// The modes are typed against `@codemirror/streamparser`, whose stream class
// is a structural twin of `@codemirror/language`'s with its own private field.
const legacy = (parser: typeof shell) =>
  Promise.resolve(
    new LanguageSupport(
      StreamLanguage.define(parser as unknown as Parameters<typeof StreamLanguage.define>[0]),
    ),
  );

export const languages: readonly LanguageDescription[] = [
  LanguageDescription.of({
    name: "CSS",
    extensions: ["css"],
    load: () => Promise.resolve(css()),
  }),
  LanguageDescription.of({
    name: "Go",
    extensions: ["go"],
    load: () => Promise.resolve(go()),
  }),
  LanguageDescription.of({
    name: "HTML",
    alias: ["xhtml"],
    extensions: ["html", "htm", "handlebars", "hbs"],
    load: () => Promise.resolve(html()),
  }),
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["ecmascript", "js", "node"],
    extensions: ["js", "mjs", "cjs"],
    load: () => Promise.resolve(javascript()),
  }),
  LanguageDescription.of({
    name: "JSON",
    alias: ["json5"],
    extensions: ["json", "map"],
    load: () => Promise.resolve(json()),
  }),
  LanguageDescription.of({
    name: "JSX",
    extensions: ["jsx"],
    load: () => Promise.resolve(javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: "Markdown",
    extensions: ["md", "markdown", "mkd"],
    load: () => Promise.resolve(markdown()),
  }),
  LanguageDescription.of({
    name: "Python",
    extensions: ["BUILD", "bzl", "py", "pyw"],
    filename: /^(BUCK|BUILD)$/,
    load: () => Promise.resolve(python()),
  }),
  LanguageDescription.of({
    name: "TSX",
    extensions: ["tsx"],
    load: () => Promise.resolve(javascript({ jsx: true, typescript: true })),
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts"],
    extensions: ["ts", "mts", "cts"],
    load: () => Promise.resolve(javascript({ typescript: true })),
  }),
  LanguageDescription.of({
    name: "XML",
    alias: ["rss", "wsdl", "xsd"],
    extensions: ["xml", "xsl", "xsd", "svg"],
    load: () => Promise.resolve(xml()),
  }),
  LanguageDescription.of({
    name: "YAML",
    alias: ["yml"],
    extensions: ["yaml", "yml"],
    load: () => Promise.resolve(yaml()),
  }),
  LanguageDescription.of({
    name: "diff",
    extensions: ["diff", "patch"],
    load: () => legacy(diff),
  }),
  LanguageDescription.of({
    name: "Dockerfile",
    filename: /^Dockerfile$/,
    load: () => legacy(dockerFile),
  }),
  LanguageDescription.of({
    name: "Lua",
    extensions: ["lua"],
    load: () => legacy(lua),
  }),
  LanguageDescription.of({
    name: "Nginx",
    filename: /nginx.*\.conf$/i,
    load: () => legacy(nginx),
  }),
  LanguageDescription.of({
    name: "Properties files",
    alias: ["ini", "properties"],
    extensions: ["properties", "ini", "in"],
    load: () => legacy(properties),
  }),
  LanguageDescription.of({
    name: "Shell",
    alias: ["bash", "sh", "zsh"],
    extensions: ["sh", "ksh", "bash"],
    filename: /^PKGBUILD$/,
    load: () => legacy(shell),
  }),
  LanguageDescription.of({
    name: "TOML",
    extensions: ["toml"],
    load: () => legacy(toml),
  }),
];
