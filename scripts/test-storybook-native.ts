import { chromium, type Page } from "playwright";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const base = process.env.STORYBOOK_URL ?? "http://127.0.0.1:6010";
const unavailable = process.argv.includes("--expect-unavailable");
if (!unavailable) {
  const nativeRoot = resolve(
    process.env.BB_STORYBOOK_SOURCE ?? resolve(import.meta.dirname, "../../bb"),
  );
  assert(
    existsSync(resolve(nativeRoot, "apps/app/node_modules/react")),
    "Native tests require a BB checkout with installed dependencies",
  );
  const app = resolve(nativeRoot, "apps/app");
  const sources = [
    "native-frame.jsx",
    "native-panel-state.jsx",
    "native-sdk.js",
    "native-slot.jsx",
  ].map((file) => resolve(import.meta.dirname, "../.storybook", file));
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noImplicitAny: false,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    paths: {
      "@/*": [resolve(app, "src/*")],
      "@bb-native/app/*": [resolve(app, "src/*")],
      "@bb-native/app/components/secondary-panel/threadSecondaryPanelAtoms?native-original": [
        resolve(app, "src/components/secondary-panel/threadSecondaryPanelAtoms.ts"),
      ],
      "@bb-native/ladle/*": [resolve(app, ".ladle/*")],
      "@bb-native/deps/jotai": [resolve(app, "node_modules/jotai/index.d.ts")],
      "@bb-native/deps/react-router-dom": [
        resolve(app, "node_modules/react-router-dom/dist/index.d.ts"),
      ],
      "@bb-native/deps/@bb/shared-ui/*": [
        resolve(nativeRoot, "packages/shared-ui/src/components/ui/*"),
      ],
      "@bb-native/deps/@bb/sdk/browser": [resolve(nativeRoot, "packages/sdk/src/browser.ts")],
    },
  };
  const program = ts.createProgram(
    [...sources, resolve(import.meta.dirname, "../.storybook/native-preview-env.d.ts")],
    options,
  );
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file && sources.includes(resolve(diagnostic.file.fileName)));
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getCanonicalFileName: (file) => file,
      getNewLine: () => "\n",
    }),
  );
  console.log("PASS: native adapter props against the installed BB source types");
}
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(30000);
const backendRequests: string[] = [];
page.on("request", (request) => {
  if (/^\/(api|ws)(\/|$)/.test(new URL(request.url()).pathname))
    backendRequests.push(request.url());
});
async function story(id: string, globals = "context:editor;width:wide") {
  await page.goto(`${base}/iframe.html?id=${id}&viewMode=story&globals=${globals}`);
}
async function ready(page: Page) {
  const frame = page.locator("[data-native-bb]");
  try {
    await frame.waitFor({ timeout: 30000 });
  } catch {
    throw new Error(
      `Native preview did not start: ${(await page.locator("body").innerText()).slice(0, 800)}`,
    );
  }
  await page.locator("[data-storybook-component]").waitFor();
}
try {
  await story("screens-github-stack-stack-panel--draft-stack");
  if (unavailable) {
    await page.getByText(/Native BB preview unavailable:/).waitFor();
    await page.getByPlaceholder(/feat\(api\)/).waitFor();
    assert.equal(await page.locator("[data-native-bb]").count(), 0);
    console.log("PASS: missing-source notice and isolated plugin content");
  } else {
    await ready(page);
    await page
      .getByText("Keep reviews readable while the checkout reconnects", { exact: true })
      .waitFor();
    assert((await page.locator('[data-testid="app-page-header-content-row"]').count()) > 0);
    assert((await page.locator("[data-panel-group]").count()) > 0);
    const input = page.getByPlaceholder(/feat\(api\)/);
    await input.fill("Preserve native preview draft");
    const composer = page.locator('[contenteditable="true"]').first();
    await composer.fill("Native composer works");
    const oldWidth = await page.evaluate(() =>
      localStorage.getItem("bb.thread.secondaryPanel.widthPercent"),
    );
    const handle = page.getByRole("separator", { name: "Resize thread and right panel" });
    const handleBox = await handle.boundingBox();
    assert(handleBox, "native resize handle is visible");
    const beforeResize = Number(await handle.getAttribute("aria-valuenow"));
    await page.mouse.move(handleBox.x, handleBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 160, handleBox.y + 100, { steps: 12 });
    await page.mouse.up();
    const afterResize = Number(await handle.getAttribute("aria-valuenow"));
    assert(Math.abs(afterResize - beforeResize) > 5, "native divider changes panel width");
    const toggle = page.getByRole("button", { name: "Toggle preview panel", exact: true });
    await toggle.click();
    await toggle.click();
    assert.equal(await input.inputValue(), "Preserve native preview draft");
    assert(
      Math.abs(Number(await handle.getAttribute("aria-valuenow")) - afterResize) < 1,
      "reopening retains this story's panel width",
    );
    assert.equal(await composer.innerText(), "Native composer works");
    assert.equal(
      await page.evaluate(() => localStorage.getItem("bb.thread.secondaryPanel.widthPercent")),
      oldWidth,
    );
    await input.focus();
    for (const width of [1000, 640, 1600]) {
      await page.setViewportSize({ width, height: 720 });
      await input.waitFor({ state: "visible" });
      await page.waitForTimeout(400);
      assert.equal(await input.inputValue(), "Preserve native preview draft");
      assert(
        await input.evaluate((element) => document.activeElement === element),
        "plugin focus survives native layout changes",
      );
      assert.equal(await composer.innerText(), "Native composer works");
    }
    assert.equal(
      backendRequests.length,
      0,
      `Unexpected backend requests: ${backendRequests.join(", ")}`,
    );
    assert.equal(await page.evaluate(() => window.__bbNativeBackendAttempts?.length ?? 0), 0);
    const blocked = await page.evaluate(async () => {
      try {
        await fetch("/api/v1/native-preview-write-probe", { method: "POST" });
        return false;
      } catch (error) {
        return error instanceof Error && error.message.includes("blocks backend access");
      }
    });
    assert(blocked, "native backend writes must be rejected before transport");
    assert.equal(backendRequests.length, 0);
    await page.evaluate(() => {
      window.__STORYBOOK_ADDONS_CHANNEL__.emit("updateGlobals", {
        globals: { context: "isolated", width: "narrow" },
      });
    });
    await page.waitForURL(/context%3Aisolated|context:isolated/);
    await input.waitFor();
    assert.equal(await page.locator("[data-native-bb]").count(), 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.bbNativePreview),
      undefined,
    );
    for (const [id, placement] of [
      ["screens-tasks-views--list", "page"],
      ["screens-dotfiles-repository--populated", "page"],
      ["screens-agent-instructions-rules-editor--populated", "settings"],
      ["components-amp-oracle-card--completed", "message"],
      ["components-devin-cloud-session--active", "composer"],
      ["components-inline-visualizations-tweak-panel--editable", "dialog"],
      ["components-gtd-sidebar-thread-cards--idle", "sidebar"],
      ["screens-vimium-link-hints--keyboard-navigation", "overlay"],
    ]) {
      assert(id && placement);
      await story(id);
      await ready(page);
      assert.equal(
        await page.locator("[data-native-bb]").getAttribute("data-placement"),
        placement,
      );
      if (placement === "dialog") {
        await page.evaluate(() =>
          window.__STORYBOOK_ADDONS_CHANNEL__.emit("updateGlobals", {
            globals: { width: "narrow" },
          }),
        );
        await page.waitForTimeout(100);
        const box = await page.locator("[data-storybook-component]").boundingBox();
        assert(box && box.width <= 361, "portaled dialog respects narrow width");
      }
      if (placement === "page") {
        await page.setViewportSize({ width: 1600, height: 400 });
        await page.waitForTimeout(250);
        const pageLayout = await page.locator("[data-storybook-component]").evaluate((slot) => ({
          height: slot.clientHeight,
          parent: slot.parentElement?.clientHeight,
          bottom: slot.getBoundingClientRect().bottom,
          viewport: innerHeight,
        }));
        assert(
          pageLayout.height > 200 && pageLayout.height === pageLayout.parent,
          "page story fills its available editor height",
        );
        assert(pageLayout.bottom <= pageLayout.viewport, "page scrolling stays inside the editor");
        if (id === "screens-tasks-views--list") {
          await page.locator("[data-task-key]").first().waitFor();
          assert(
            await page
              .locator("[data-storybook-component]")
              .evaluate((slot) =>
                [...slot.querySelectorAll("*")].some(
                  (node) =>
                    getComputedStyle(node).overflowY === "auto" &&
                    node.scrollHeight > node.clientHeight,
                ),
              ),
            "long Tasks screen scrolls inside the short editor",
          );
        }
        await page.setViewportSize({ width: 1600, height: 720 });
      }
      if (id === "screens-tasks-views--list") {
        await page.locator("[data-task-key]").first().waitFor();
        assert.equal(
          await page
            .locator("[data-task-key]")
            .first()
            .evaluate((row) => getComputedStyle(row).display),
          "flex",
          "native styles preserve responsive plugin utilities",
        );
      }
    }
    console.log("PASS: native placements, responsive plugin utilities and portal widths");
    await story("components-code-review-comment-form--empty");
    await ready(page);
    await page.evaluate(() =>
      window.__STORYBOOK_ADDONS_CHANNEL__.emit("updateStoryArgs", {
        storyId: "components-code-review-comment-form--empty",
        updatedArgs: { label: "Review comment?" },
      }),
    );
    await page.getByRole("textbox", { name: "Review comment?", exact: true }).waitFor();
    await page.evaluate(() =>
      window.__STORYBOOK_ADDONS_CHANNEL__.emit("updateGlobals", {
        globals: { context: "isolated" },
      }),
    );
    await page.waitForURL(/context%3Aisolated|context:isolated/);
    await page.getByRole("textbox", { name: "Review comment?", exact: true }).waitFor();
    await page.evaluate(() =>
      window.__STORYBOOK_ADDONS_CHANNEL__.emit("updateStoryArgs", {
        storyId: "components-code-review-comment-form--empty",
        updatedArgs: { label: "Updated comment!" },
      }),
    );
    const updatedField = page.getByRole("textbox", { name: "Updated comment!", exact: true });
    await updatedField.waitFor();
    const beforeRemount = await updatedField.elementHandle();
    await page.evaluate(() =>
      window.__STORYBOOK_ADDONS_CHANNEL__.emit("forceRemount", {
        storyId: "components-code-review-comment-form--empty",
      }),
    );
    await page.waitForFunction((element) => !element?.isConnected, beforeRemount);
    await updatedField.waitFor();
    console.log("PASS: punctuation Controls survive reload and newer Controls survive remount");
    await story("components-code-review-comment-form--empty");
    await ready(page);
    await page.evaluate(() =>
      window.__STORYBOOK_ADDONS_CHANNEL__.emit("updateStoryArgs", {
        storyId: "components-code-review-comment-form--empty",
        updatedArgs: { label: { invalid: "plugin render probe" } },
      }),
    );
    await page
      .getByText(/Objects are not valid as a React child/)
      .first()
      .waitFor();
    assert.equal(
      await page.getByText(/Native BB preview failed:/).count(),
      0,
      "plugin render errors remain Storybook errors, not native-shell errors",
    );
    console.log("PASS: plugin errors reach the Storybook error surface");
    assert.equal(backendRequests.length, 0);
    console.log(
      "PASS: native chrome, fixture RPC, native composer, resize, close/reopen, storage and backend isolation, isolated document transition",
    );
  }
} finally {
  await browser.close();
}
