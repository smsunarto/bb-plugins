import { expect, test } from "bun:test";
import { LanguageDescription, LanguageSupport } from "@codemirror/language";
import { languages } from "./editor-languages.ts";

test("files a dotfiles repository holds get a grammar", async () => {
  const cases = {
    "mise.toml": "TOML",
    "settings.json": "JSON",
    "compose.yml": "YAML",
    "install.sh": "Shell",
    "init.lua": "Lua",
    "main.go": "Go",
    "tool.py": "Python",
    "hook.ts": "TypeScript",
    "app.tsx": "TSX",
    "theme.css": "CSS",
    "com.example.plist.xml": "XML",
    "desktop.ini": "Properties files",
    "nginx.conf": "Nginx",
    Dockerfile: "Dockerfile",
    "fix.patch": "diff",
  };
  for (const [filename, name] of Object.entries(cases)) {
    const language = LanguageDescription.matchFilename(languages, filename);
    expect(language?.name, filename).toBe(name);
    expect(await language!.load(), filename).toBeInstanceOf(LanguageSupport);
  }
});

test("a file in a language outside the list opens as plain text", () => {
  expect(LanguageDescription.matchFilename(languages, "main.rs")).toBeNull();
});
