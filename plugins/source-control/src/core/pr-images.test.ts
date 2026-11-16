import { expect, test } from "vitest";
import {
  imageIdentity,
  parseGitHubImage,
  refSplits,
  routeGitHubImages,
  servesImage,
} from "./pr-images.ts";

const UPLOAD = "https://github.com/user-attachments/assets/0993b262-b0ae-4631-b40a-65c93ae1420c";
const FILE =
  "https://github.com/Argus-Labs/rampage-client/blob/054abe656d5af7fc1c87f819bb1dd2d0b06223bc/docs/shot.png?raw=true";

test("parseGitHubImage takes GitHub's uploads and committed files only", () => {
  expect(parseGitHubImage(UPLOAD)).toEqual({
    kind: "attachment",
    url: UPLOAD,
    id: "0993b262-b0ae-4631-b40a-65c93ae1420c",
  });
  expect(
    parseGitHubImage("https://github.com/o/r/assets/4402697/0993b262-b0ae-4631-b40a-65c93ae1420c"),
  ).toMatchObject({ kind: "attachment" });
  expect(parseGitHubImage(FILE)).toEqual({
    kind: "file",
    url: FILE,
    repo: { owner: "argus-labs", name: "rampage-client" },
    segments: ["054abe656d5af7fc1c87f819bb1dd2d0b06223bc", "docs", "shot.png"],
  });
  expect(parseGitHubImage("https://github.com/o/r/raw/main/a%20b.png")).toMatchObject({
    kind: "file",
    segments: ["main", "a b.png"],
  });
  expect(parseGitHubImage("https://raw.githubusercontent.com/o/r/main/a.png")).toMatchObject({
    kind: "file",
    repo: { owner: "o", name: "r" },
  });

  for (const other of [
    "http://github.com/user-attachments/assets/0993b262-b0ae-4631-b40a-65c93ae1420c",
    "https://evil.example/user-attachments/assets/0993b262-b0ae-4631-b40a-65c93ae1420c",
    "https://github.com.evil.example/user-attachments/assets/0993b262-b0ae-4631-b40a-65c93ae1420c",
    "https://user@github.com/user-attachments/assets/0993b262-b0ae-4631-b40a-65c93ae1420c",
    "https://github.com:8443/user-attachments/assets/0993b262-b0ae-4631-b40a-65c93ae1420c",
    "https://github.com/user-attachments/assets/not-an-id",
    "https://github.com/o/r/blob/main/a.png",
    "https://github.com/o/r/blob/main/../../x.png?raw=true",
    "https://github.com/o/r/pull/1",
    "https://github.com/o/r/raw/trunk/x%2F..%2F..%2Fother%2Frepo%2Fa.png",
    "https://github.com/o/r/raw/trunk/x%5C..%5Ca.png",
    "https://github.com/o/r/raw/main/%2E%2E/a.png",
    "https://github.com/o/r/raw/main/README.md",
    "https://raw.githubusercontent.com/o/r/main/.env",
    "https://github.com/login",
    "https://user-images.githubusercontent.com/1/abc.png",
    "https://www.cubic.dev/buttons/review-in-cubic-light.svg",
    "javascript:alert(1)",
    "",
  ])
    expect(parseGitHubImage(other), other).toBeNull();
});

test("routeGitHubImages swaps GitHub image sources in Markdown and HTML, nothing else", () => {
  const route = (src: string) => `/route?src=${encodeURIComponent(src)}`;
  const body = [
    `![shot](${UPLOAD})`,
    `![titled](${FILE} "a title")`,
    `![angled](<${UPLOAD}>)`,
    `<img width="300" alt="dark" src="${UPLOAD}" />`,
    `<img src='${FILE.replace("&", "&amp;")}' height=200>`,
    `[a link to it](${UPLOAD})`,
    `![badge](https://img.shields.io/badge/x-y-green)`,
    `<img alt="cubic" src="https://www.cubic.dev/buttons/review-in-cubic-light.svg">`,
  ].join("\n");
  expect(routeGitHubImages(body, route).split("\n")).toEqual([
    `![shot](${route(UPLOAD)})`,
    `![titled](${route(FILE)} "a title")`,
    `![angled](<${route(UPLOAD)}>)`,
    `<img width="300" alt="dark" src="${route(UPLOAD)}" />`,
    `<img src="${route(FILE)}" height=200>`,
    `[a link to it](${UPLOAD})`,
    `![badge](https://img.shields.io/badge/x-y-green)`,
    `<img alt="cubic" src="https://www.cubic.dev/buttons/review-in-cubic-light.svg">`,
  ]);
});

test("only the pull request's own repository or head fork has its committed files routed", () => {
  const repo = { owner: "Argus-Labs", name: "rampage-client" };
  const serves = (src: string) => servesImage(parseGitHubImage(src)!, repo, "someone");
  expect(serves(UPLOAD)).toBe(true);
  expect(serves(FILE)).toBe(true);
  expect(serves("https://github.com/someone/rampage-client/raw/main/a.png")).toBe(true);
  expect(serves("https://github.com/get-bb/bb/blob/main/a.png?raw=true")).toBe(false);
  const body = `![a](${FILE}) ![b](https://github.com/get-bb/bb/blob/main/a.png?raw=true)`;
  expect(
    routeGitHubImages(
      body,
      () => "/route",
      (image) => servesImage(image, repo, "someone"),
    ),
  ).toBe("![a](/route) ![b](https://github.com/get-bb/bb/blob/main/a.png?raw=true)");
});

test("one image is one identity, however its URL is spelled", () => {
  const id = (src: string) => imageIdentity(parseGitHubImage(src)!);
  expect(id(`${UPLOAD}?v=1`)).toBe(id(`${UPLOAD}?v=2#a`));
  expect(
    id(
      UPLOAD.toUpperCase().replace(
        "HTTPS://GITHUB.COM/USER-ATTACHMENTS/ASSETS",
        "https://github.com/user-attachments/assets",
      ),
    ),
  ).toBe(id(UPLOAD));
  expect(id("https://github.com/O/R/raw/main/a.png")).toBe(
    id("https://raw.githubusercontent.com/o/r/main/a.png"),
  );
});

test("refSplits tries the pull request's branches first, then short refs, bounded", () => {
  const segments = ["scott", "sc-pr-images", "docs", "a.png"];
  expect(refSplits(segments, ["scott/sc-pr-images", "main"]).map((split) => split.ref)).toEqual([
    "scott/sc-pr-images",
    "scott",
    "scott/sc-pr-images/docs",
  ]);
  expect(refSplits(segments, ["scott/sc-pr-images"])[0]).toEqual({
    ref: "scott/sc-pr-images",
    path: "docs/a.png",
  });
  expect(refSplits(["refs", "heads", "main", "a.png"])).toEqual([{ ref: "main", path: "a.png" }]);
  expect(refSplits(Array.from({ length: 30 }, (_, n) => `s${n}`).concat("a.png"))).toHaveLength(4);
});

test("image syntax in code, comments and escapes stays as written; parentheses balance", () => {
  const route = () => "ROUTE";
  const upload = `![a](${UPLOAD})`;
  const cases: [string, string][] = [
    ["```\n" + upload + "\n```", "```\n" + upload + "\n```"],
    [
      "```suggestion\n" + upload + "\n```\n" + upload,
      "```suggestion\n" + upload + "\n```\n![a](ROUTE)",
    ],
    ["~~~~md\n" + upload + "\n~~~\n~~~~", "~~~~md\n" + upload + "\n~~~\n~~~~"],
    ["`" + upload + "` " + upload, "`" + upload + "` ![a](ROUTE)"],
    ["``a ` " + upload + "``", "``a ` " + upload + "``"],
    ["<!-- " + upload + " --> " + upload, "<!-- " + upload + " --> ![a](ROUTE)"],
    ["\\" + upload, "\\" + upload],
    ["`unclosed " + upload, "`unclosed ![a](ROUTE)"],
    ["![a](https://github.com/o/r/raw/main/docs/Screenshot_(1).png) after", "![a](ROUTE) after"],
    ["![a [b] c](" + UPLOAD + ")", "![a [b] c](ROUTE)"],
  ];
  for (const [body, expected] of cases) expect(routeGitHubImages(body, route), body).toBe(expected);
});

test("hostile text is scanned in linear work, and stops being rewritten rather than blocking", () => {
  for (const unit of [
    "![",
    "<img ",
    "`",
    "![a](",
    "[",
    "<!-",
    "``` ",
    "<pre ",
    "<code>",
    "\n\n    x",
    '<img alt="x" ',
  ]) {
    const body = unit.repeat(Math.ceil(65_536 / unit.length));
    const work = { steps: 0 };
    routeGitHubImages(body, () => "ROUTE", undefined, work);
    expect(work.steps, unit).toBeLessThanOrEqual(body.length * 8 + 1_024 + 8_192);
  }
  const work = { steps: 0 };
  const normal = `text ![a](${UPLOAD}) more\n`.repeat(1_000);
  expect(routeGitHubImages(normal, () => "R", undefined, work)).toBe(
    "text ![a](R) more\n".repeat(1_000),
  );
});

test("an escaped destination is routed as the renderer reads it, and a stray backslash is refused", () => {
  const seen: string[] = [];
  const route = (src: string) => {
    seen.push(src);
    return "ROUTE";
  };
  expect(routeGitHubImages("![a](https://github.com/o/r/raw/main/shot_\\(1\\).png)", route)).toBe(
    "![a](ROUTE)",
  );
  expect(seen).toEqual(["https://github.com/o/r/raw/main/shot_(1).png"]);
  expect(parseGitHubImage("https://github.com/o/r/raw/main/a\\b.png")).toBeNull();
});

test("?raw=1 is a committed image too", () => {
  expect(parseGitHubImage("https://github.com/o/r/blob/main/a.png?raw=1")).toMatchObject({
    kind: "file",
  });
});

test("only an img tag's own src attribute is rewritten, never text inside another attribute", () => {
  const body = `<img alt="x src=${UPLOAD}" src="${UPLOAD}">`;
  expect(routeGitHubImages(body, () => "ROUTE")).toBe(`<img alt="x src=${UPLOAD}" src="ROUTE">`);
  expect(routeGitHubImages(`<img alt="no source here">`, () => "ROUTE")).toBe(
    `<img alt="no source here">`,
  );
});

test("indented code, <pre> and <code> stay as written; a list's indented image is still routed", () => {
  const route = () => "ROUTE";
  const upload = `![a](${UPLOAD})`;
  const cases: [string, string][] = [
    [`text\n\n    ${upload}\n\n${upload}`, `text\n\n    ${upload}\n\n![a](ROUTE)`],
    [`<pre>\n${upload}\n</pre>\n${upload}`, `<pre>\n${upload}\n</pre>\n![a](ROUTE)`],
    [`<code>${upload}</code> ${upload}`, `<code>${upload}</code> ![a](ROUTE)`],
    [`<pre unclosed ${upload}`, `<pre unclosed ![a](ROUTE)`],
    [`- item\n\n    ${upload}`, `- item\n\n    ![a](ROUTE)`],
    ["```x``` " + upload, "```x``` ![a](ROUTE)"],
  ];
  for (const [body, expected] of cases) expect(routeGitHubImages(body, route), body).toBe(expected);
});
