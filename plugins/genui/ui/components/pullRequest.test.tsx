// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PullRequestInfo,
  PullRequestRef,
  PullRequestsResult,
  PullRequestResult,
} from "../../core/project";
import { UiRuntimeContext, type UiRuntime } from "../runtime";
import type { Props } from "../values";
import { PullRequest } from "./pullRequest";

type Call = { method: string; input: { refs?: PullRequestRef[] } };
const calls: Call[] = [];
/** Each repository's answer, settled by the test when it chooses. */
const pending = new Map<
  string,
  { resolve: (answer: PullRequestsResult) => void; reject: (error: Error) => void }
>();
let branchAnswer: PullRequestResult;

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  experimental_Icon: ({ name }: { name: string }) => <i data-icon={name} />,
  UrlLink: ({
    href,
    title,
    className,
    children,
  }: {
    href: string;
    title?: string;
    className?: string;
    children: ReactNode;
  }) => (
    <a href={href} title={title} className={className}>
      {children}
    </a>
  ),
  useRpc: () => ({
    call: (method: string, input: Call["input"]) => {
      calls.push({ method, input });
      if (method === "project_pull_request") return Promise.resolve(branchAnswer);
      const repo = `${input.refs![0]!.owner}/${input.refs![0]!.repo}`;
      return new Promise((resolve, reject) => pending.set(repo, { resolve, reject }));
    },
  }),
}));

const NOW = Date.UTC(2026, 10, 12, 12);

function pr(
  owner: string,
  repo: string,
  number: number,
  state: PullRequestInfo["state"],
): PullRequestInfo {
  return {
    number,
    title: `Change ${number}`,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    state,
    baseRef: "main",
    headRef: `feat/${number}`,
    checks: { state: "passing", passed: 5, failed: 0, pending: 0, total: 5 },
    review: { state: "approved", requests: 0 },
    mergeability: "mergeable",
    attention: state === "merged" ? "merged" : "ready_to_merge",
    autoMerge: false,
    inMergeQueue: false,
    updatedAt: NOW,
  };
}

function runtime(): UiRuntime {
  return {
    setValue() {},
    async run() {},
    openFile: null,
    loadImage: null,
    holdHeight: () => () => {},
    readText: null,
    loadAudio: null,
    loadVideo: null,
    loadAsset: null,
    superseded: false,
    threadId: "thr_mine00",
    blockKey: null,
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: () => ({ cancel() {} }),
  });
  calls.length = 0;
  pending.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(props: Props) {
  act(() =>
    root.render(
      <UiRuntimeContext value={runtime()}>
        <PullRequest props={props} />
      </UiRuntimeContext>,
    ),
  );
}

const rows = () => [...container.querySelectorAll("li")];

describe("PullRequest(refs)", () => {
  it("reads each repository on its own: its rows show as it answers, while another's still load or fail alone", async () => {
    render({
      refs: [
        "Argus-Labs/rampage-client#2419",
        "argus-labs/other#7",
        "Argus-Labs/rampage-client#2420",
      ],
    });
    // One read per repository, with that repository's refs only.
    expect(calls.map((call) => call.input.refs!.map((ref) => ref.number))).toEqual([
      [2419, 2420],
      [7],
    ]);
    expect(rows()).toHaveLength(3);
    expect(rows().every((row) => row.getAttribute("aria-busy") === "true")).toBe(true);

    await act(async () =>
      pending.get("Argus-Labs/rampage-client")!.resolve({
        ok: true,
        fetchedAt: NOW,
        rows: [
          {
            ref: { owner: "Argus-Labs", repo: "rampage-client", number: 2419 },
            read: {
              ok: true,
              pullRequest: pr("Argus-Labs", "rampage-client", 2419, "merged"),
              settling: false,
            },
          },
          {
            ref: { owner: "Argus-Labs", repo: "rampage-client", number: 2420 },
            read: {
              ok: true,
              pullRequest: pr("Argus-Labs", "rampage-client", 2420, "open"),
              settling: false,
            },
          },
        ],
      }),
    );
    // Rows stay in the order named; the other repository's row is still loading.
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Argus-Labs/rampage-client #2419 Change 2419"),
      expect.stringContaining("argus-labs/other #7"),
      expect.stringContaining("Argus-Labs/rampage-client #2420 Change 2420"),
    ]);
    expect(rows()[0]!.textContent).toContain("Merged");
    expect(rows()[2]!.textContent).toContain("Ready to merge");
    expect(rows()[1]!.getAttribute("aria-busy")).toBe("true");

    await act(async () =>
      pending.get("argus-labs/other")!.reject(new Error("Source Control is disabled")),
    );
    expect(rows()[1]!.getAttribute("aria-busy")).toBeNull();
    expect(rows()[1]!.textContent).toContain("Source Control is disabled");
    expect(rows()[0]!.textContent).toContain("Merged");
  });

  it("shows one named pull request as the branch's card does", async () => {
    render({ refs: ["https://github.com/Argus-Labs/rampage-client/pull/2423"] });
    await act(async () =>
      pending.get("Argus-Labs/rampage-client")!.resolve({
        ok: true,
        fetchedAt: NOW,
        rows: [
          {
            ref: { owner: "Argus-Labs", repo: "rampage-client", number: 2423 },
            read: {
              ok: true,
              pullRequest: pr("Argus-Labs", "rampage-client", 2423, "draft"),
              settling: false,
            },
          },
        ],
      }),
    );
    expect(container.querySelector("a")!.getAttribute("href")).toBe(
      "https://github.com/Argus-Labs/rampage-client/pull/2423",
    );
    expect(container.textContent).toContain("#2423 Change 2423");
    expect(container.textContent).toContain("Draft");
  });

  it("without refs, still shows this branch's pull request from BB", async () => {
    branchAnswer = {
      ok: true,
      branch: "feat/x",
      pullRequest: pr("o", "r", 367, "open"),
      fetchedAt: NOW,
    };
    await act(async () => render({}));
    expect(calls.map((call) => call.method)).toEqual(["project_pull_request"]);
    expect(container.textContent).toContain("#367 Change 367");
  });

  it("says what is wrong with a ref instead of reading", () => {
    render({ refs: ["rampage-client#2419"] });
    expect(calls).toHaveLength(0);
    expect(container.textContent).toContain('"rampage-client#2419" is not "owner/repo#123"');
  });
  it("while the first ref still streams in, waits quietly instead of reading or erroring", () => {
    render({ refs: [] });
    expect(calls).toHaveLength(0);
    expect(container.querySelector('[aria-label="Loading pull requests"]')).not.toBeNull();
  });
});
