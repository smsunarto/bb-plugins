// The page layer against a scripted browser: what it sends for text, uploads, and the log tail.
import { expect, test } from "bun:test";

import { BrowserCommandError, type BrowserRunner } from "../src/server/browser.ts";
import { SauceError, createSaucePage } from "../src/server/live.ts";

const SESSION = "https://app.saucelabs.com/live/mobile/dataCenters/US/devices/x";
const HOME = "https://app.saucelabs.com/live/app-testing";

/** A browser that records commands and answers each `eval` from the first matching rule. */
function scripted(
  rules: [RegExp, (script: string) => unknown][],
  on: (args: string[]) => void = () => {},
) {
  const sent: string[][] = [];
  const browser: BrowserRunner = {
    async run(args) {
      sent.push([...args]);
      on([...args]);
      if (args[0] !== "eval") return {};
      const script = args[1] ?? "";
      for (const [pattern, answer] of rules)
        if (pattern.test(script)) return { result: answer(script) };
      return { result: null };
    },
  };
  let clock = 0;
  const page = createSaucePage(browser, {
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    grayThumbnail: async () => null,
  });
  return {
    page,
    sent,
    commands: () =>
      sent.filter((args) => args[0] !== "eval").map((args) => args.slice(0, 2).join(" ")),
  };
}

const onSession = (url = SESSION): [RegExp, () => unknown] => [
  /location\.href/,
  () => ({
    url,
    host: "app.saucelabs.com",
    path: new URL(url).pathname,
    ended: false,
    device: "Samsung Galaxy S23 - Android 16",
    capacity: false,
  }),
];

async function codeOf(work: Promise<unknown>) {
  try {
    await work;
    return "ok";
  } catch (error) {
    return error instanceof SauceError ? error.code : String(error);
  }
}

test("text goes to the device as one paste, after the pointer brings the keyboard box back", async () => {
  let hovered = false;
  let pasted = "";
  const { page, commands } = scripted(
    [
      onSession(),
      [
        /ClipboardEvent\("paste"/,
        (script) => {
          pasted = /setData\("text\/plain", (".*?")\);/s.exec(script)?.[1] ?? "";
          return hovered;
        },
      ],
      // Sauce removes the box when focus moves to its own controls; a hover mounts and focuses it.
      [
        /activeElement === document\.querySelector\("textarea\.testobject-device__paste-area"\)/,
        () => hovered,
      ],
    ],
    (args) => {
      if (args[0] === "hover") hovered = true;
    },
  );
  await page.typeText('Q&A "x" é');
  expect(JSON.parse(pasted)).toBe('Q&A "x" é');
  expect(commands()).toEqual(["hover canvas.testobject-device__canvas"]);
});

test("no text or key is sent while the keyboard box cannot take focus", async () => {
  const { page, sent } = scripted([onSession(), [/activeElement ===/, () => false]]);
  expect(await codeOf(page.typeText("abc"))).toBe("page_changed");
  expect(await codeOf(page.pressKey("enter"))).toBe("page_changed");
  expect(sent.some((args) => args[0] === "press" || /ClipboardEvent/.test(args[1] ?? ""))).toBe(
    false,
  );
});

test("a key is pressed only once the keyboard box has focus", async () => {
  const { page, commands } = scripted([onSession(), [/activeElement ===/, () => true]]);
  await page.pressKey("backspace");
  expect(commands()).toEqual(["press Backspace"]);
});

test("the log tail opens the Device Log panel only when it is not showing", async () => {
  let open = false;
  const { page, commands } = scripted(
    [
      onSession(),
      [/LogLine__/, () => (open ? ["13:04:25 E Unity : boom"] : null)],
      [/\[role=tab\]/, () => true],
    ],
    (args) => {
      if (args[0] === "find" && args.includes("Device Log")) open = true;
    },
  );
  expect(await page.logTail()).toEqual(["13:04:25 E Unity : boom"]);
  expect(commands()).toEqual(["find role"]);
  expect(await page.logTail()).toEqual(["13:04:25 E Unity : boom"]);
  expect(commands()).toEqual(["find role"]);
});

test("an upload Sauce refuses is reported in Sauce's words, and the tab goes back to Sauce Live", async () => {
  let url = HOME;
  let uploaded = false;
  const { page, sent } = scripted(
    [
      [
        /location\.href/,
        () => ({
          url,
          host: "app.saucelabs.com",
          path: new URL(url).pathname,
          ended: false,
          device: null,
          capacity: false,
        }),
      ],
      [
        /notifications-wrapper/,
        () =>
          uploaded
            ? '406 NotAcceptable Uploading has failed. Unable to parse "x.apk" as a valid ZIP archive.'
            : "",
      ],
      [/app-search-and-select-file-id-/, () => [{ id: "f1", label: "Rampage/build.apk" }]],
      [/./, () => true],
    ],
    (args) => {
      if (args[0] === "open") url = args[1] ?? url;
      if (args[0] === "upload") uploaded = true;
    },
  );
  const refused = page.uploadApp("/builds/x.apk", "x.apk", 60_000);
  await expect(refused).rejects.toMatchObject({ code: "upload_rejected" });
  await expect(refused).rejects.toThrow("Unable to parse");
  expect(sent.find((args) => args[0] === "upload")).toEqual([
    "upload",
    "[data-qa=app-management-upload-box-input]",
    "/builds/x.apk",
  ]);
  expect(url).toBe(HOME);
});

test("a download Sauce never delivers is a timeout the caller can retry", async () => {
  const { page } = scripted(
    [
      onSession(),
      [/getBoundingClientRect/, () => ({ left: 0, top: 0, width: 404, height: 878 })],
      [/Take Screenshot/, () => true],
    ],
    (args) => {
      if (args[0] === "download") throw new BrowserCommandError("download", "Operation timed out.");
    },
  );
  expect(await codeOf(page.captureScreen("/tmp/bb-sauce-page-test/none.png"))).toBe("timeout");
});

test("a touch or text refused while Sauce covers the device sends nothing", async () => {
  const { page, commands } = scripted([
    onSession(),
    [/elementFromPoint/, () => "Installing your app..."],
    [/getBoundingClientRect/, () => ({ left: 726, top: 89, width: 404, height: 878 })],
  ]);
  const tapped = page.tap({ x: 0.5, y: 0.5 }, 0);
  await expect(tapped).rejects.toMatchObject({ code: "not_ready" });
  await expect(tapped).rejects.toThrow("Installing your app...");
  expect(await codeOf(page.drag({ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }, 0, 300, 0))).toBe(
    "not_ready",
  );
  expect(await codeOf(page.typeText("abc"))).toBe("not_ready");
  expect(commands()).toEqual([]);
});

test("an upload waits out a progress notice and returns the build once Sauce lists it", async () => {
  let url = HOME;
  let notices = 0;
  let uploaded = false;
  const { page } = scripted(
    [
      [
        /location\.href/,
        () => ({
          url,
          host: "app.saucelabs.com",
          path: new URL(url).pathname,
          ended: false,
          device: null,
          capacity: false,
        }),
      ],
      [
        /notifications-wrapper/,
        () => (uploaded ? (++notices < 3 ? "Uploading app.apk 40%" : "app.apk uploaded") : ""),
      ],
      [
        /app-search-and-select-file-id-/,
        () => [
          ...(uploaded && url === HOME ? [{ id: "f2", label: "Demo/app.apk v2" }] : []),
          { id: "f1", label: "Demo/app.apk v1" },
        ],
      ],
      [/./, () => true],
    ],
    (args) => {
      if (args[0] === "open") url = args[1] ?? url;
      if (args[0] === "upload") uploaded = true;
    },
  );
  expect(await page.uploadApp("/builds/app.apk", "app.apk", 60_000)).toEqual({
    id: "f2",
    label: "Demo/app.apk v2",
  });
  // The tab stayed on the upload page until the notice stopped reporting progress.
  expect(notices).toBe(3);
});

const PORTRAIT = { left: 726, top: 89, width: 404, height: 878 };
const LANDSCAPE = { left: 361, top: 180, width: 878, height: 404 };

test("orienting clicks Rotate Device only when the canvas is the other shape, and waits for it to turn", async () => {
  let canvas = PORTRAIT;
  const { page, commands } = scripted(
    [onSession(), [/getBoundingClientRect/, () => canvas]],
    (args) => {
      if (args[0] === "find" && args.includes("Rotate Device")) canvas = LANDSCAPE;
    },
  );
  expect(await page.orient("portrait")).toEqual({ turned: false });
  expect(commands()).toEqual([]);
  expect(await page.orient("landscape")).toEqual({ turned: true });
  expect(await page.orient("landscape")).toEqual({ turned: false });
  expect(commands()).toEqual(["find role"]);
});

test("a device that never turns is a timeout after one click, not a second toggle", async () => {
  const { page, commands } = scripted([onSession(), [/getBoundingClientRect/, () => PORTRAIT]]);
  const turning = page.orient("landscape");
  await expect(turning).rejects.toMatchObject({ code: "timeout" });
  await expect(turning).rejects.toThrow("did not turn landscape");
  expect(commands()).toEqual(["find role"]);
});
