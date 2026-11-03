// @vitest-environment jsdom

import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { TooltipProvider } from "@/components/ui/tooltip";
import { makeSidebarThread } from "../model/fixtures.ts";
import type { SidebarThread } from "../model/sidebar-thread.ts";

installTestPluginRuntime();
const { GtdMachineGlobe, GtdRowExtrasProvider, GtdWakeTime, useGtdMenuHaptic, useGtdNamingProps } =
  await import("./row-extras.tsx");

const HOUR_MS = 60 * 60 * 1000;
const LAPTOP = { id: "host_laptop", name: "Laptop" };
const SERVER = { id: "host_server", name: "Server" };

function NamingProbe({ threadId }: { threadId: string }) {
  const props = useGtdNamingProps(threadId);
  return <span data-testid={`title-${threadId}`} {...props} />;
}

function HapticProbe() {
  const play = useGtdMenuHaptic();
  return (
    <button type="button" onClick={() => play(true)}>
      open
    </button>
  );
}

function Harness({ threads, wakeAt }: { threads: SidebarThread[]; wakeAt?: Map<string, number> }) {
  return (
    <TooltipProvider>
      <GtdRowExtrasProvider
        hosts={[LAPTOP, SERVER]}
        wakeAtFor={(thread) => wakeAt?.get(thread.id) ?? null}
      >
        {threads.map((thread) => (
          <div key={thread.id} data-testid={`row-${thread.id}`}>
            <GtdMachineGlobe host={thread.host} />
            <NamingProbe threadId={thread.id} />
            <GtdWakeTime thread={thread} />
          </div>
        ))}
        <HapticProbe />
      </GtdRowExtrasProvider>
    </TooltipProvider>
  );
}

function render(
  threads: SidebarThread[],
  {
    settings = {},
    naming = [],
    wakeAt,
  }: {
    settings?: Record<string, string | number | boolean>;
    naming?: string[];
    wakeAt?: Map<string, number>;
  } = {},
) {
  return renderSlot(
    { component: Harness },
    { threads, wakeAt },
    {
      settings,
      rpc: { listNamingThreads: () => naming },
      sdk: {
        system: { config: vi.fn().mockResolvedValue({ primaryHostId: LAPTOP.id }) },
        hosts: {
          list: vi.fn().mockResolvedValue([
            { ...LAPTOP, machineProviderId: null },
            { ...SERVER, machineProviderId: "boat-sandbox" },
          ]),
        },
      },
    },
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { bb?: unknown }).bb;
});

describe("GTD row extras", () => {
  it("marks only threads on another machine, Boat sandboxes with a bot", async () => {
    render([
      makeSidebarThread({ id: "local", host: LAPTOP }),
      makeSidebarThread({ id: "remote", host: SERVER }),
      makeSidebarThread({ id: "nowhere", host: null }),
    ]);
    expect(await screen.findByRole("img", { name: "On Server" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "On Laptop" })).toBeNull();
    expect(screen.getByTestId("row-nowhere").querySelector("[data-gtd-machine]")).toBeNull();
    // The Boat sandbox drops its machine color once the host catalog lands.
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "On Server" }).getAttribute("style")).toContain(
        "var(--muted-foreground)",
      ),
    );
  });

  it("colors a machine's globe by its id", async () => {
    render([makeSidebarThread({ id: "remote", host: { id: "host_other", name: "Other" } })]);
    const globe = await screen.findByRole("img", { name: "On Other" });
    expect(globe.getAttribute("style")).toContain("var(--machine-");
  });

  it("treats the Local machine setting as home instead of bb's primary host", async () => {
    render(
      [
        makeSidebarThread({ id: "laptop", host: LAPTOP }),
        makeSidebarThread({ id: "server", host: SERVER }),
      ],
      { settings: { localMachineId: SERVER.id } },
    );
    expect(await screen.findByRole("img", { name: "On Laptop" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "On Server" })).toBeNull();
  });

  it("shimmers the title of a thread GTD is naming", async () => {
    render([makeSidebarThread({ id: "naming" }), makeSidebarThread({ id: "named" })], {
      naming: ["naming"],
    });
    await waitFor(() =>
      expect(screen.getByTestId("title-naming").getAttribute("data-gtd-naming")).toBe("true"),
    );
    expect(screen.getByTestId("title-naming").className).toContain("gtd-naming-text");
    expect(screen.getByTestId("title-named").hasAttribute("data-gtd-naming")).toBe(false);
  });

  it("counts down to a snoozed thread's wake time", () => {
    // The row counts from the start of the current minute, rounding up.
    const wakeAt = new Map([["parked", Date.now() + 2.5 * HOUR_MS]]);
    render([makeSidebarThread({ id: "parked" }), makeSidebarThread({ id: "awake" })], { wakeAt });
    const parked = screen.getByTestId("row-parked").querySelector("[data-gtd-wake]");
    expect(parked?.textContent).toBe("3h");
    expect(parked?.getAttribute("title")).toMatch(/^Wakes /);
    expect(screen.getByTestId("row-awake").querySelector("[data-gtd-wake]")).toBeNull();
  });

  it("plays bb's native haptic as a menu opens only when the user opted in", async () => {
    const post = vi.fn();
    (window as { bb?: unknown }).bb = { native: { post, capabilities: ["haptic"] } };
    const off = render([]);
    screen.getByRole("button", { name: "open" }).click();
    expect(post).not.toHaveBeenCalled();
    off.lifecycle.unmount();
    render([], { settings: { mobileHaptics: true } });
    screen.getByRole("button", { name: "open" }).click();
    expect(post).toHaveBeenCalledWith({ type: "haptic", kind: "impact-medium" });
  });
});
