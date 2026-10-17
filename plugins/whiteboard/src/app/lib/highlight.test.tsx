// @vitest-environment jsdom
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentMarkdown } from "../markdown/agent-markdown.tsx";
import { RenderedCodeBlock } from "../vendor/review/app/src/code-block.tsx";
import { CodeThemeProvider } from "./highlight.tsx";

const monokai: PluginCodeThemeData = {
  name: "test-monokai",
  type: "dark",
  fg: "#e3e3dd",
  bg: "#181818",
  colors: { "editorLineNumber.foreground": "#555555" },
  tokenColors: [
    { scope: ["keyword", "storage"], settings: { foreground: "#fe5d86" } },
    { scope: "string", settings: { foreground: "#f7d05c" } },
    { scope: "constant.numeric", settings: { foreground: "#a895fe" } },
    { scope: "comment", settings: { foreground: "#7c7865", fontStyle: "italic" } },
  ],
};

const codeTheme = vi.hoisted(() => ({ theme: null as PluginCodeThemeData | null }));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useCodeTheme: () => ({ mode: "dark", name: "test", theme: codeTheme.theme }),
}));

afterEach(cleanup);

function renderThemed(children: ReactNode, theme: PluginCodeThemeData | null = monokai) {
  codeTheme.theme = theme;
  return render(<CodeThemeProvider>{children}</CodeThemeProvider>);
}

describe("code highlighting", () => {
  it("paints a code block in bb's code theme", () => {
    const { container } = renderThemed(
      <RenderedCodeBlock code="const x = 1; // one" language="ts" lineNumbers />,
    );

    // The whole figure, header included, takes the theme's ground and ink.
    const figure = container.querySelector("figure")!;
    expect(figure.hasAttribute("data-code-theme")).toBe(true);
    expect(figure.style.background).toBe("rgb(24, 24, 24)");
    expect(figure.style.color).toBe("rgb(227, 227, 221)");
    expect(figure.style.getPropertyValue("--wb-code-line-number")).toBe("#555555");
    expect(figure.querySelector("code")?.innerHTML).toBe(
      '<span style="color: rgb(254, 93, 134);">const</span> x ' +
        '<span style="color: rgb(254, 93, 134);">=</span> ' +
        '<span style="color: rgb(168, 149, 254);">1</span>; ' +
        '<span style="color: rgb(124, 120, 101); font-style: italic;">// one</span>',
    );
  });

  it("paints markdown fences in the schema's markup", () => {
    const { container } = renderThemed(<AgentMarkdown source={'```py\nprint("hi")\n```'} />);

    expect(container.querySelector("pre")?.outerHTML).toBe(
      '<pre style="background: rgb(24, 24, 24); color: rgb(227, 227, 221); ' +
        '--wb-code-bg: #181818; --wb-code-fg: #e3e3dd; --wb-code-line-number: #555555;">' +
        '<code class="language-py">print(<span style="color: rgb(247, 208, 92);">"hi"</span>)' +
        "</code></pre>",
    );
  });

  it("highlights JSX through the TSX grammar and keeps the text", () => {
    const code = "const a = <App />;\n// end\n";
    const { container } = renderThemed(<RenderedCodeBlock code={code} language="JSX" />);

    expect(container.querySelector("code")?.textContent).toBe(code);
    expect(container.querySelector("code span")?.outerHTML).toBe(
      '<span style="color: rgb(254, 93, 134);">const</span>',
    );
  });

  it("puts unknown languages on the theme's ground, plain", () => {
    const { container } = renderThemed(
      <RenderedCodeBlock code="+[--->++<]>+." language="brainfuck" />,
    );

    expect(container.querySelector("code")?.innerHTML).toBe("+[---&gt;++&lt;]&gt;+.");
    expect(container.querySelector("figure")?.style.background).toBe("rgb(24, 24, 24)");
  });

  it("renders plain until bb resolves a theme", () => {
    const { container } = renderThemed(
      <>
        <RenderedCodeBlock code="const x = 1;" language="ts" />
        <RenderedCodeBlock code="+[--->++<]>+." language="brainfuck" />
      </>,
      null,
    );

    expect([...container.querySelectorAll("code")].map((code) => code.innerHTML)).toEqual([
      "const x = 1;",
      "+[---&gt;++&lt;]&gt;+.",
    ]);
    expect(container.querySelector("figure")?.getAttribute("style")).toBeNull();
    expect(container.querySelector("figure")?.hasAttribute("data-code-theme")).toBe(false);
  });

  it("follows a theme switch", () => {
    const light = { ...monokai, name: "test-light", type: "light" as const, bg: "#ffffff" };
    renderThemed(<RenderedCodeBlock code="let y;" language="ts" />).unmount();
    const { container } = renderThemed(<RenderedCodeBlock code="let y;" language="ts" />, light);

    expect(container.querySelector("figure")?.style.background).toBe("rgb(255, 255, 255)");
  });
});
