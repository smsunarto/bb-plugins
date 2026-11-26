// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import type {
  ComposerDraftReplacement,
  ComposerDraftSnapshot,
  PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlotFence } from "../SlotFence";

declare const jsdom: { window: Window };

function fakeComposer(threadId: string) {
  let draft: ComposerDraftSnapshot = { text: "", mentions: [], attachments: [] };
  let version = 0;
  const listeners = new Set<() => void>();
  const set = (next: ComposerDraftSnapshot) => {
    draft = next;
    version++;
    for (const listener of listeners) listener();
  };
  const handle = {
    scope: { kind: "thread", threadId },
    key: `thread:${threadId}`,
    get draft() {
      return draft;
    },
    get text() {
      return draft.text;
    },
    get isEmpty() {
      return draft.text.trim() === "" && draft.mentions.length === 0;
    },
    replace(
      next:
        | ComposerDraftReplacement
        | ((current: ComposerDraftSnapshot) => ComposerDraftReplacement),
    ) {
      const result = typeof next === "function" ? next(draft) : next;
      if (result === draft) return;
      set({ text: result.text, mentions: [...result.mentions], attachments: draft.attachments });
    },
    insert(parts: string | readonly string[]) {
      const text = typeof parts === "string" ? parts : parts.join("");
      set({ ...draft, text: `${draft.text}${text}` });
    },
    onSubmitted: () => () => {},
    isSubmitting: false,
    focus: vi.fn(),
    submit: vi.fn(),
  };
  return {
    composer: handle as unknown as PluginComposerApi,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}

const bb = vi.hoisted(() => ({
  composers: null as null | ReturnType<typeof fakeComposer>,
  send: vi.fn(async () => ({})),
}));

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  useComposers: () => {
    const fake = bb.composers;
    useSyncExternalStore(fake?.subscribe ?? (() => () => undefined), () => fake?.version() ?? 0);
    return fake === null ? [] : [fake.composer];
  },
  useSdk: () => ({ threads: { send: bb.send } }),
  useBbNavigate: () => ({}),
  useRpc: () => ({ call: vi.fn() }),
  useSettings: () => ({ values: { animations: false }, isLoading: false }),
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
  experimental_Icon: ({ name }: { name: string }) => <i data-icon={name} />,
}));
vi.mock("../useSuperseded", () => ({
  useSuperseded: () => false,
  useReplyIndex: () => 2,
}));

async function wait(ms: number) {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

let thread = 0;

function mountBlock(code: string) {
  const threadId = `thr_val_${++thread}`;
  const fake = fakeComposer(threadId);
  bb.composers = fake;
  const message = { id: `${threadId}:assistant:1`, threadId, turnId: "turn", projectId: "project" };
  const rendered = render(
    <SlotFence
      language="ui"
      status="closed"
      code={code}
      index={0}
      message={message}
      Original={() => <pre />}
    />,
  );
  return { container: rendered.container, fake };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("CSS", { supports: () => false });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("localStorage", jsdom.window.localStorage);
  localStorage.clear();
  bb.send.mockClear();
});

afterEach(() => {
  cleanup();
  bb.composers = null;
  vi.unstubAllGlobals();
});

describe("validated Form + visible + Watch UI integration", () => {
  it("shows inline errors on blur, blocks composer staging while invalid, reveals untouched errors on Show, and stages once fixed", async () => {
    const { container, fake } = mountBlock(`$account = "Personal"
$email = ""
$company = ""
Card("Sign up", [Form([
  Choice($account, ["Personal", "Team"], label: "Account"),
  Input($email, label: "Email", checks: ["required", "email"]),
  Input($company, label: "Company", visible: $account == "Team", checks: ["required"])
])])`);

    // Initial render is calm: no visible error alerts before interaction.
    expect(within(container).queryByRole("alert")).toBeNull();
    expect(fake.composer.draft.text).toBe("");

    // Type an invalid email and blur: inline alert appears and composer stays empty.
    const email = within(container).getByLabelText("Email");
    fireEvent.change(email, { target: { value: "not-an-email" } });
    fireEvent.blur(email);
    await wait(350);
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(within(container).getByRole("alert").textContent).toBe("Enter a valid email");
    expect(fake.composer.draft.text).toBe("");
    expect(within(container).getByText(/1 field needs attention/)).toBeTruthy();

    // Fix the email: error clears immediately and Form stages into composer.
    fireEvent.change(email, { target: { value: "ada@acme.dev" } });
    await wait(350);
    expect(within(container).queryByRole("alert")).toBeNull();
    expect(fake.composer.draft.text).toBe("Account: Personal\nEmail: ada@acme.dev");
    expect(within(container).getByText("In your message")).toBeTruthy();

    // Switch to Team: Company appears (required & empty) → Form withdraws staged answer and offers "Show".
    fireEvent.click(within(container).getByRole("radio", { name: "Team" }));
    expect(fake.composer.draft.text).toBe("");
    const show = within(container).getByRole("button", { name: "Show" });
    fireEvent.click(show);
    expect(within(container).getByRole("alert").textContent).toBe("Required");

    // Fill Company → Form stages all three valid lines.
    fireEvent.change(within(container).getByLabelText("Company"), { target: { value: "Acme" } });
    await wait(350);
    expect(fake.composer.draft.text).toBe("Account: Team\nEmail: ada@acme.dev\nCompany: Acme");
  });

  it("runs Watch atomically on state changes so cascading fields stage consistent answers", () => {
    const { container, fake } = mountBlock(`$cloud = "AWS"
$region = "us-east-1"
regions = {AWS: ["us-east-1", "eu-west-1"], GCP: ["us-central1", "europe-west1"]}
Watch($cloud, Set($region, regions[$cloud][0]))
Card("Deploy", [Form([
  Choice($cloud, ["AWS", "GCP"], label: "Cloud"),
  Choice($region, regions[$cloud], label: "Region")
])])`);

    // Switching Cloud to GCP updates Region atomically to "us-central1" — never stages stale "us-east-1".
    fireEvent.click(within(container).getByRole("radio", { name: "GCP" }));
    expect(fake.composer.draft.text).toBe("Cloud: GCP\nRegion: us-central1");
    expect(
      within(container).getByRole("radio", { name: "us-central1" }).getAttribute("aria-checked"),
    ).toBe("true");
  });
});
