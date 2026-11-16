import { expect, test } from "vitest";
import { parseGitHubImage, routeGitHubImages, servesImage } from "./pr-images.ts";

const UPLOAD = "https://github.com/user-attachments/assets/0993b262-b0ae-4631-b40a-65c93ae1420c";
const FILE =
  "https://github.com/Argus-Labs/rampage-client/blob/054abe656d5af7fc1c87f819bb1dd2d0b06223bc/docs/shot.png?raw=true";

test("parseGitHubImage takes GitHub's uploads and committed files only", () => {
  expect(parseGitHubImage(UPLOAD)).toEqual({ kind: "attachment", url: UPLOAD });
  expect(
    parseGitHubImage("https://github.com/o/r/assets/4402697/0993b262-b0ae-4631-b40a-65c93ae1420c"),
  ).toMatchObject({ kind: "attachment" });
  expect(parseGitHubImage(FILE)).toEqual({
    kind: "file",
    url: FILE,
    repo: { owner: "argus-labs", name: "rampage-client" },
    ref: "054abe656d5af7fc1c87f819bb1dd2d0b06223bc",
    path: "docs/shot.png",
  });
  expect(parseGitHubImage("https://github.com/o/r/raw/main/a%20b.png")).toMatchObject({
    kind: "file",
    ref: "main",
    path: "a b.png",
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
