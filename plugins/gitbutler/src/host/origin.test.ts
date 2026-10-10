import { expect, test } from "bun:test";
import { normalizeOrigin } from "./origin.ts";

test("every spelling of one GitHub repository is the same origin", () => {
  for (const url of [
    "git@github.com:smsunarto/bb-plugins.git",
    "https://github.com/smsunarto/bb-plugins",
    "https://github.com/smsunarto/bb-plugins.git/",
    "https://scott:token@github.com/smsunarto/bb-plugins.git",
    "ssh://git@github.com/smsunarto/bb-plugins.git",
    "ssh://git@github.com:22/SMSunarto/BB-Plugins\n",
  ]) {
    expect(normalizeOrigin(url)).toBe("github.com/smsunarto/bb-plugins");
  }
});

test("a port other than the scheme's own names another server", () => {
  expect(normalizeOrigin("ssh://git@example.test:2222/o/app.git")).toBe("example.test:2222/o/app");
  expect(normalizeOrigin("ssh://git@example.test:2223/o/app.git")).toBe("example.test:2223/o/app");
  expect(normalizeOrigin("https://example.test:443/o/app")).toBe("example.test/o/app");
  expect(normalizeOrigin("https://example.test:8443/o/app")).toBe("example.test:8443/o/app");
});

test("a local path stays a path, case and all, and nothing is no origin", () => {
  expect(normalizeOrigin("/srv/git/App.git")).toBe("/srv/git/App");
  expect(normalizeOrigin("file:///srv/git/App.git")).toBe("file:///srv/git/App");
  expect(normalizeOrigin("./relative/path:with-colon")).toBe("./relative/path:with-colon");
  expect(normalizeOrigin("  \n")).toBeNull();
});

test("different repositories stay different", () => {
  expect(normalizeOrigin("git@github.com:smsunarto/dotfiles.git")).not.toBe(
    normalizeOrigin("git@github.com:smsunarto/bb-plugins.git"),
  );
  expect(normalizeOrigin("git@gitlab.com:smsunarto/bb-plugins.git")).toBe(
    "gitlab.com/smsunarto/bb-plugins",
  );
});
