import { describe, expect, test } from "vitest";
import { readHtmlRenderDirective } from "../../shared/html-render.ts";
import { render } from "./render.ts";

function context() {
  const pages = new Map<
    string,
    { threadId: string; title: string; height: number; html: string }
  >();
  const ctx = {
    store: {
      save(page: { threadId: string; title: string; height: number; html: string }) {
        const id = `page${String(pages.size).padStart(20, "0")}`;
        pages.set(id, page);
        return id;
      },
      html: (id: string) => pages.get(id)?.html,
      deleteThread() {},
    },
    threadFiles: () => async () => undefined,
  };
  return { tool: render(ctx as never), pages };
}

const invocation = { threadId: "thr_1", projectId: "proj_1", signal: new AbortController().signal };

const text = (result: unknown) =>
  typeof result === "string"
    ? result
    : (result as { content: { text: string }[] }).content[0]!.text;

describe("html_render", () => {
  test("stores the prepared page and returns its directive", async () => {
    const { tool, pages } = context();
    const result = await tool.execute(
      { html: "<p>Hi</p>", title: "Greeting", height: 120 },
      invocation,
    );
    const line = text(result)
      .split("\n")
      .find((entry) => entry.startsWith("::html-render{"));
    expect(line).toBeDefined();
    const attributes = Object.fromEntries(
      [...line!.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]),
    );
    const reference = readHtmlRenderDirective(attributes);
    expect(reference).toEqual({ id: expect.any(String), title: "Greeting", height: 120 });
    const page = pages.get(reference!.id);
    expect(page?.threadId).toBe("thr_1");
    // The viewer adds the runtime with its own theme, so the page is stored as written.
    expect(page?.html).toBe("<p>Hi</p>");
  });

  test("returns page errors to the agent instead of storing", async () => {
    const { tool, pages } = context();
    const vh = await tool.execute(
      {
        html: "<style>body{height:100vh}</style>",
        title: "x",
        height: 80,
      },
      invocation,
    );
    expect(vh).toMatchObject({ isError: true });
    const missing = await tool.execute(
      {
        html: '<img src="/nope.png">',
        title: "x",
        height: 80,
      },
      invocation,
    );
    expect(text(missing)).toContain("/nope.png");
    expect(pages.size).toBe(0);
  });
});
