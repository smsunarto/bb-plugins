// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, Value } from "../../core/types";
import { useBlockAnswerTarget, type AnswerTarget } from "../LiveUi";
import { AnswersContext, UiRuntimeContext, type UiRuntime } from "../runtime";
import type { Props } from "../values";
import { FollowUps } from "./choose";
import { List } from "./explain";
import { Button } from "./inputs";

// BB draws icons; here each is an element naming its icon, in place.
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  experimental_Icon: ({ name }: { name: string }) => <i data-icon={name} />,
  useSettings: () => ({ values: undefined, isLoading: true }),
  useComposers: () => [],
}));

const send = (text: string): Action => ({ kind: "action", type: "send", text });
const open = (url: string): Action => ({ kind: "action", type: "openUrl", url });
const copy = (text: string): Action => ({ kind: "action", type: "copy", text });
const set = (name: string, value: Value): Action => ({ kind: "action", type: "set", name, value });

const run = vi.fn(async (_actions: readonly Action[]) => {});
const runtime: UiRuntime = {
  setValue() {},
  run,
  openFile: null,
  loadImage: null,
  holdHeight: () => () => {},
  readText: null,
  loadAudio: null,
  loadAsset: null,
  superseded: false,
  threadId: null,
  blockKey: null,
};

/** The gallery's answer sheet: a pick goes into the (previewed) message, as it would into a thread's composer. */
const GALLERY: AnswerTarget = { kind: "gallery" };
/** A block's questions on the answer sheet `target`; each test is its own block, so no pick carries over. */
let blockKey = "";
function Block({ target, children }: { target: AnswerTarget; children: ReactNode }) {
  const answers = useBlockAnswerTarget(target, blockKey, false, () => 0);
  return <AnswersContext value={answers}>{children}</AnswersContext>;
}

let container: HTMLDivElement;
let root: Root;
let blocks = 0;
beforeEach(() => {
  blockKey = `inputs.test:${++blocks}`;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no Web Animations, which entrances play.
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: () => ({ cancel() {} }) });
  run.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(element: ReactNode, target: AnswerTarget = GALLERY): void {
  act(() =>
    root.render(
      <UiRuntimeContext value={runtime}>
        <Block target={target}>{element}</Block>
      </UiRuntimeContext>,
    ),
  );
}

/** A button's content in order: `[Name]` for an icon, its text otherwise. */
function face(button: Element): string {
  return [...button.querySelectorAll("[data-icon], span")]
    .map((part) => (part.hasAttribute("data-icon") ? `[${part.getAttribute("data-icon")}]` : part.textContent))
    .join(" ");
}

/** The hint a keyboard user gets on focusing `button`, or null when it has none. */
function hintOnFocus(button: HTMLElement): string | null {
  // BB's tooltip opens on focus only after keyboard input, as a Tab would be.
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    button.focus();
  });
  const hint = document.querySelector('[role="tooltip"]')?.textContent ?? null;
  act(() => button.blur());
  return hint;
}

function renderButton(props: Props, target?: AnswerTarget): HTMLButtonElement {
  render(<Button props={props} />, target);
  return container.querySelector("button")!;
}

describe("Button", () => {
  it("ends a reply choice with the send glyph, and its hint says the pick goes into the message, then back out", async () => {
    const button = renderButton({ label: "Use Redis" });
    expect(face(button)).toBe("Use Redis [Sent]");
    expect(hintOnFocus(button)).toBe("Add to your message");
    await act(async () => button.click());
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(face(button)).toBe("[Check] Use Redis [Sent]");
    expect(hintOnFocus(button)).toBe("Take it out of your message");
  });

  it("says a pick is sent at once where the thread has no composer, and sends it", async () => {
    const posted = vi.fn(async (_text: string) => {});
    const target: AnswerTarget = { kind: "thread", threadId: `direct:${blocks}`, messageId: "reply", fence: 0, reply: null, send: posted };
    const button = renderButton({ label: "Use Redis" }, target);
    expect(hintOnFocus(button)).toBe("Send as your reply");
    await act(async () => button.click());
    expect(posted).toHaveBeenCalledWith("Use Redis");
  });

  it("quotes a label the button's width cuts off", () => {
    const label = "Keep the retry policy but add exponential backoff with jitter for 5xx";
    const button = renderButton({ label });
    const shown = [...button.querySelectorAll("span")].find((span) => span.textContent === label)!;
    Object.defineProperty(shown, "scrollWidth", { configurable: true, value: 480 });
    Object.defineProperty(shown, "clientWidth", { configurable: true, value: 220 });
    expect(hintOnFocus(button)).toBe(`Add “${label}” to your message`);
  });

  it("keeps the spec's icon in front and the action's glyph at the end", () => {
    const pr = renderButton({ label: "Open the PR", action: [send("Open a PR for this branch")], icon: "git-pull-request" });
    expect(face(pr)).toBe("[GitPullRequest] Open the PR [Sent]");
    expect(hintOnFocus(pr)).toBe("Add “Open a PR for this branch” to your message");

    const notes = renderButton({ label: "Release notes", action: [open("https://github.com/vitest-dev/vitest/releases")], icon: "github" });
    expect(face(notes)).toBe("[Github] Release notes [ExternalLink]");
    expect(hintOnFocus(notes)).toBe("Open https://github.com/vitest-dev/vitest/releases");
  });

  it("draws an action's glyph given as the icon once, at the end, and never for another action", () => {
    expect(face(renderButton({ label: "Copy branch name", action: [copy("fix/upload-race")], icon: "Copy" }))).toBe(
      "Copy branch name [Copy]",
    );
    expect(face(renderButton({ label: "Read the docs", action: [send("Summarise the docs")], icon: "external-link" }))).toBe(
      "Read the docs [Sent]",
    );
  });

  it("gives a button that only changes this UI no glyph and no hint", () => {
    const button = renderButton({ label: "Reset", action: [set("seats", 10)], icon: "RotateCcw" });
    expect(face(button)).toBe("[RotateCcw] Reset");
    expect(hintOnFocus(button)).toBeNull();
  });

  it("keeps a focused button mounted when its action turns into one with a hint", () => {
    // Button("Next", $step < 2 ? Set($step, $step + 1) : Send("Done")), pressed from the keyboard.
    const step = (action: Action) => render(<Button props={{ label: "Next", action: [action] }} />);
    step(set("step", 2));
    const button = container.querySelector("button")!;
    act(() => button.focus());
    step(send("Done"));
    expect(container.querySelector("button")).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(face(button)).toBe("Next [Sent]");
    step(set("step", 0));
    expect(container.querySelector("button")).toBe(button);
    expect(face(button)).toBe("Next");
  });

  it("runs the other actions and stages the answer when picked, the hint naming each outward one", async () => {
    const actions = [set("plan", "Pro"), copy("PRO-2026"), send("Go with Pro")];
    const button = renderButton({ label: "Go with Pro", action: actions, variant: "primary" });
    expect(face(button)).toBe("Go with Pro [Sent]");
    expect(hintOnFocus(button)).toBe("Copy “PRO-2026”\nAdd to your message");
    await act(async () => button.click());
    expect(run).toHaveBeenCalledWith(actions.slice(0, 2));
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(hintOnFocus(button)).toBe("Take it out of your message");
  });
});

describe("List rows", () => {
  it("end with what a tap does: send, open, or a chevron for a row that changes this UI", () => {
    render(
      <List
        props={{
          items: [
            { title: "Bump vitest to 4.1", action: send("Bump vitest to 4.1") },
            { title: "Release notes", action: open("https://github.com/vitest-dev/vitest/releases") },
            { title: "Show the details", action: set("open", true) },
          ],
        }}
      />,
    );
    const rows = [...container.querySelectorAll("button")];
    expect(rows.map((row) => row.querySelector("[data-icon]")?.getAttribute("data-icon"))).toEqual([
      "Sent",
      "ExternalLink",
      "ChevronRight",
    ]);
    expect(rows.map(hintOnFocus)).toEqual(["Add to your message", "Open https://github.com/vitest-dev/vitest/releases", null]);
  });

  it("draw an action's glyph given as a row's icon once, at the end, and keep it on a row that doesn't act", () => {
    render(
      <List
        props={{
          items: [
            { title: "Copy the token", icon: "Copy", action: copy("ghp_example") },
            { title: "Read the docs", icon: "external-link", action: send("Summarise the docs") },
            { title: "Copied to your clipboard", icon: "Copy" },
          ],
        }}
      />,
    );
    const icons = [...container.querySelectorAll("li")].map((row) => [...row.querySelectorAll("[data-icon]")].map((icon) => icon.getAttribute("data-icon")));
    expect(icons).toEqual([["Copy"], ["Sent"], ["Copy"]]);
  });

  it("put the hint at the row's end, where it lets clicks through to the row above", () => {
    render(<List props={{ items: [{ title: "Release notes", action: open("https://example.com/notes") }] }} />);
    const row = container.querySelector("button")!;
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
      row.focus();
    });
    const content = document.querySelector("[data-align]");
    expect(content?.getAttribute("data-align")).toBe("end");
    expect(content?.classList.contains("pointer-events-none")).toBe(true);
    act(() => row.blur());
  });
});

describe("FollowUps", () => {
  it("end with the send glyph, and the hint says the prompt goes into the message", () => {
    render(<FollowUps props={{ prompts: ["How do I deploy this?"] }} />);
    const row = container.querySelector("button")!;
    expect(face(row)).toBe("How do I deploy this? [Sent]");
    expect(hintOnFocus(row)).toBe("Add to your message");
  });
});
