// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Value } from "../../core/types";
import { useBlockAnswerTarget } from "../LiveUi";
import { AnswersContext, UiRuntimeContext, type UiRuntime } from "../runtime";
import type { Props } from "../values";
import { Acceptance } from "./Acceptance";
import { Findings } from "./Findings";
import { Provenance } from "./Provenance";

// BB draws icons, links and markdown; here each is a plain element.
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  experimental_Icon: ({ name }: { name: string }) => <i data-icon={name} />,
  Markdown: ({ children }: { children: string }) => <span>{children}</span>,
  UrlLink: ({ href, title, className, children }: { href: string; title?: string; className?: string; children: ReactNode }) => (
    <a href={href} title={title} className={className}>
      {children}
    </a>
  ),
  useSdk: () => ({ threads: { get: async () => ({}) } }),
  useSettings: () => ({ values: undefined, isLoading: true }),
}));

const openFile = vi.fn(async (_path: string, _line?: number) => true);
const toastError = vi.spyOn(toast, "error").mockImplementation(() => "");

function runtime(canOpen: boolean): UiRuntime {
  return {
    setValue() {},
    async run() {},
    openFile: canOpen ? openFile : null,
    loadImage: null,
    holdHeight: () => () => {},
    readText: null,
    loadAudio: null,
    loadAsset: null,
    superseded: false,
    threadId: null,
    blockKey: null,
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no Web Animations, which entrances play.
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: () => ({ cancel() {} }) });
  openFile.mockClear();
  toastError.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** The gallery's answer sheet, which Findings' fix buttons stage into. */
function Answers({ children }: { children: ReactNode }) {
  return <AnswersContext value={useBlockAnswerTarget({ kind: "gallery" }, "fileRows.test", false, () => 0)}>{children}</AnswersContext>;
}

function render(component: (props: { props: Props }) => ReactNode, props: Props, canOpen = true): void {
  const Component = component;
  act(() =>
    root.render(
      <UiRuntimeContext value={runtime(canOpen)}>
        <Answers>
          <Component props={props} />
        </Answers>
      </UiRuntimeContext>,
    ),
  );
}

const renderFindings = (items: Value, canOpen = true) => render(Findings, { items }, canOpen);

/** Presses the first button whose text starts with `text`. */
function press(text: string): void {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().startsWith(text));
  if (button === undefined) throw new Error(`No button "${text}"`);
  act(() => button.click());
}

const icons = (element: Element) => [...element.querySelectorAll("[data-icon]")].map((icon) => icon.getAttribute("data-icon"));

describe("A file group's header", () => {
  const items: Value = [
    { severity: "high", title: "fitView drops the zoom it computed", file: "src/mapMath.ts", line: 74 },
    { severity: "low", title: "Unused debug option", file: "src/mapMath.ts", line: 88 },
  ];

  it("is one control, the file icon and the path, that opens the file", async () => {
    renderFindings(items);
    const header = container.querySelector("h4")!;
    const link = header.querySelector("button")!;
    expect(link.title).toBe("Open src/mapMath.ts");
    expect(link.textContent).toBe("src/mapMath.ts");
    expect(icons(header)).toEqual(["FileText"]);
    await act(async () => link.click());
    expect(openFile).toHaveBeenCalledWith("src/mapMath.ts", undefined);
  });

  it("reads as plain text where BB can't open files", () => {
    renderFindings(items, false);
    const header = container.querySelector("h4")!;
    expect(header.querySelector("button")).toBeNull();
    expect(icons(header)).toEqual(["FileText"]);
    expect(header.textContent).toContain("src/mapMath.ts");
  });
});

describe("A review's artifacts", () => {
  it("open a file in BB and a web address as a link, each marked once", async () => {
    renderFindings({
      verdict: "fix-required",
      findings: [{ id: "S1", severity: "P1", area: "hud", issue: "The HUD overlaps the arena", status: "open" }],
      artifacts: ["review/hud-390x844.png", "https://ci.example.com/runs/42"],
    });
    press("Review evidence");
    const [file, web] = [...container.querySelectorAll('[aria-label="Review evidence"] li')];
    expect(file!.querySelector("button")!.title).toBe("Open review/hud-390x844.png");
    expect(icons(file!)).toEqual(["FileText"]);
    expect(web!.querySelector("a")!.getAttribute("href")).toBe("https://ci.example.com/runs/42");
    expect(icons(web!)).toEqual(["Globe", "ExternalLink"]);
    await act(async () => file!.querySelector("button")!.click());
    expect(openFile).toHaveBeenCalledWith("review/hud-390x844.png", undefined);
  });
});

describe("Acceptance's file evidence", () => {
  const criteria: Value = {
    criteria: [
      {
        name: "The gate result is kept",
        status: "passed",
        evidence: [
          { path: "data/acceptance/coil-gate.json", label: "Gate result" },
          { url: "https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/", label: "WAI-ARIA disclosure pattern" },
        ],
      },
    ],
  };

  it("is one box that opens the file, as the link's box beside it opens the page", async () => {
    render(Acceptance, { criteria });
    press("The gate result is kept");
    const box = container.querySelector<HTMLButtonElement>('button[title="Open data/acceptance/coil-gate.json"]')!;
    expect(box.textContent).toBe("Gate resultdata/acceptance/coil-gate.json");
    expect(icons(box)).toEqual(["FileText"]);
    await act(async () => box.click());
    expect(openFile).toHaveBeenCalledWith("data/acceptance/coil-gate.json", undefined);
  });

  it("says so when BB can't open the file", async () => {
    openFile.mockResolvedValueOnce(false);
    render(Acceptance, { criteria });
    press("The gate result is kept");
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Open data/acceptance/coil-gate.json"]')!.click());
    expect(toastError).toHaveBeenCalledWith("Couldn't open data/acceptance/coil-gate.json");
  });

  it("is a plain box where BB can't open files", () => {
    render(Acceptance, { criteria }, false);
    press("The gate result is kept");
    const box = container.querySelector('[title="data/acceptance/coil-gate.json"]')!;
    expect(box.tagName).toBe("DIV");
    expect(icons(box)).toEqual(["FileText"]);
  });
});

describe("Provenance's file evidence", () => {
  /** The evidence frame of the one stage, opened. */
  function frame(path: string): Element {
    render(Provenance, { stages: [{ name: "Build on build-mini", status: "done", evidence: path }] });
    press("Build on build-mini");
    return container.querySelector(`[title="${path}"]`)!.closest(".rounded-lg")!;
  }

  it("ends its header with the open button, the one file icon", () => {
    const evidence = frame("logs/xcodebuild-2811.log");
    expect(icons(evidence)).toEqual(["FileText"]);
    expect(evidence.querySelector('button[aria-label="Open logs/xcodebuild-2811.log"]')).not.toBeNull();
  });

  it("leads with a plain file icon where BB can't open the file", () => {
    const evidence = frame("/var/log/xcodebuild-2811.log");
    expect(icons(evidence)).toEqual(["FileText"]);
    expect(evidence.querySelector("button")).toBeNull();
  });
});
