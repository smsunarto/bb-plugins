#!/usr/bin/env bun
/**
 * Recapture the production bb UI images the READMEs ship: the close-ups
 * plugin-screenshots.ts stages into heroes, and the standalone captures a
 * README embeds directly.
 *
 * The browser renders at DPR 3 while the final heroes render at DPR 2. Every
 * foreground image is therefore downsampled in the hero instead of enlarged.
 * Visible plugin data is fixed at the HTTP RPC boundary; bb and each plugin's
 * production components still own the markup, CSS, fonts, and layout.
 *
 *   bun run screenshots:fixtures
 *   bun run screenshots:fixtures --plugin amp
 *   bun run screenshots:fixtures --output-dir /tmp/bb-plugin-fixtures
 */
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from "playwright";
import {
  createScreenshotContext,
  createScreenshotPage,
  launchScreenshotBrowser,
  parseScreenshotArguments,
  prepareBbForScreenshots,
  SCREENSHOT_PREFLIGHT_PLUGINS,
  SCREENSHOT_ROOT,
  SCREENSHOT_THEME_ID,
  type ScreenshotBatch,
  type ScreenshotClip,
  type ScreenshotOptions,
  withScreenshotBatch,
} from "./plugin-screenshot-runtime";

const ROOT = SCREENSHOT_ROOT;
const DPR = 3;
const APP_VIEWPORT = { width: 1512, height: 1000 } as const;
const FIXED_TIME = new Date("2026-08-13T12:00:00.000Z");
const SIDEBAR_PROVIDER_KEY = "bb.sidebar.threadListProvider";
const SIDEBAR_PROVIDER = "gtd-sidebar/inbox";
/**
 * The title gtd-sidebar registers for that provider. The Appearance capture
 * exists to show it, so the run fails rather than shipping an image of some
 * other list.
 */
const SIDEBAR_PROVIDER_TITLE = "GTD Sidebar (inbox)";
const SIDEBAR_PLUGIN_ORDER_KEY = "bb.sidebar.pluginPanelOrder";
/**
 * bb's own Extensions row. It is pinned above the plugin rows and is not part
 * of the reorderable set — `bb.sidebar.pluginPanelOrder` holds
 * `<pluginId>/<panelId>` keys only — so it belongs in what the navigation
 * assertion expects and not in what the run seeds.
 */
const SIDEBAR_BUILTIN_LEAD_LABEL = "Extensions";
/**
 * The panels the screenshot instance draws, in order.
 *
 * This is the set a bb dev instance carries once the workspace plugins are
 * installed into it: bb's built-in automations, plus the three workspace
 * plugins that register a sidebar panel. It deliberately does not list panels
 * that only exist on a developer's personal bb — a plugin installed there but
 * absent here would make the run depend on who is capturing.
 */
const SIDEBAR_PLUGIN_ORDER = [
  { id: "automations/automations", label: "Automations" },
  { id: "agentation/annotations", label: "Agentation" },
  { id: "dotfiles/dotfiles", label: "Dotfiles" },
  { id: "agent-proxy/agent-proxy", label: "Agent Proxy" },
] as const;
const DEFAULT_PROJECT_ID = "proj_b25re9h8d7";
const IDLE_THREAD_ID = "thr_fytu99znvt";
const ORACLE_THREAD_ID = "thr_4c8sv4qav3";
const STACK_PROJECT_ID = "proj_dhxdkz286e";
const STACK_THREAD_ID = "thr_cpc9jzpn5j";
const EXECUTION_OPTIONS = {
  providers: [{
    available: true,
    capabilities: {
      supportsArchive: false,
      supportsRename: false,
      supportsServiceTier: true,
      supportsUserQuestion: false,
      supportsFork: false,
      supportedPermissionModes: ["accept-edits", "full"],
    },
    composerActions: [{ kind: "skills", trigger: "/" }],
    displayName: "Amp",
    id: "acp-amp",
    logoUrl: "/api/v1/system/providers/acp-amp/logo",
  }],
  permissionCeiling: "full",
  models: [
    { id: "low", model: "low", displayName: "Low", description: "", supportedReasoningEfforts: [], defaultReasoningEffort: "medium", isDefault: false },
    { id: "medium", model: "medium", displayName: "Medium", description: "", supportedReasoningEfforts: [], defaultReasoningEffort: "medium", isDefault: true },
    { id: "high", model: "high", displayName: "High", description: "", supportedReasoningEfforts: [], defaultReasoningEffort: "medium", isDefault: false },
    { id: "ultra", model: "ultra", displayName: "Ultra", description: "", supportedReasoningEfforts: [], defaultReasoningEffort: "medium", isDefault: false },
  ],
  selectedOnlyModels: [],
  modelLoadError: null,
} as const;
const SCREENSHOT_HOST = {
  id: "host_screenshot",
  name: "Screenshot Host",
  type: "persistent",
  status: "connected",
  maxPermissionMode: "full",
  lastSeenAt: FIXED_TIME.valueOf(),
  lastRejectedProtocolVersion: null,
  createdAt: FIXED_TIME.valueOf() - 86_400_000,
  updatedAt: FIXED_TIME.valueOf(),
} as const;
const PROVIDER_CLI_STATUS = {
  codex: {
    displayName: "Codex",
    executableName: "codex",
    executablePath: "/Users/example/.local/bin/codex",
    installed: true,
    installSource: "external",
    currentVersion: "0.147.0",
    latestVersion: "0.147.0",
    minimumSupportedVersion: "0.136.0",
    npmPackageName: "@openai/codex",
    npmGlobalPackageVersion: null,
    installAction: null,
    needsUpdate: false,
    versionUnsupported: false,
  },
  claudeCode: {
    displayName: "Claude Code",
    executableName: "claude",
    executablePath: "/Users/example/.local/bin/claude",
    installed: true,
    installSource: "external",
    currentVersion: "2.1.229",
    latestVersion: "2.1.229",
    minimumSupportedVersion: null,
    npmPackageName: "@anthropic-ai/claude-code",
    npmGlobalPackageVersion: null,
    installAction: null,
    needsUpdate: false,
    versionUnsupported: false,
  },
  cursor: {
    displayName: "Cursor",
    executableName: "cursor-agent",
    executablePath: null,
    installed: false,
    installSource: "notInstalled",
    currentVersion: null,
    latestVersion: null,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: null,
    needsUpdate: false,
    versionUnsupported: false,
  },
} as const;

export interface FixtureSpec {
  id: string;
  plugin: string;
  filename: string;
  width: number;
  height: number;
}

export const PLUGIN_SCREENSHOT_FIXTURES: readonly FixtureSpec[] = [
  { id: "agent-proxy/home", plugin: "agent-proxy", filename: "home.png", width: 596, height: 500 },
  { id: "agent-proxy/agents", plugin: "agent-proxy", filename: "agents.png", width: 596, height: 500 },
  { id: "agentation/capture", plugin: "agentation", filename: "capture.png", width: 873, height: 470 },
  { id: "agentation/staging", plugin: "agentation", filename: "staging.png", width: 749, height: 284 },
  { id: "amp/orb-prompt", plugin: "amp", filename: "orb-prompt.png", width: 774, height: 211 },
  { id: "amp/orb-bar", plugin: "amp", filename: "orb-bar.png", width: 755, height: 263 },
  { id: "amp/oracle-card", plugin: "amp", filename: "oracle-card.png", width: 751, height: 270 },
  { id: "gh-stack/new-tab", plugin: "gh-stack", filename: "new-tab.png", width: 576, height: 418 },
  { id: "gh-stack/magic-stack-report", plugin: "gh-stack", filename: "magic-stack-report.png", width: 798, height: 598 },
  { id: "gh-stack/magic-stack-result", plugin: "gh-stack", filename: "magic-stack-result.png", width: 596, height: 1000 },
  { id: "gtd-sidebar/sidebar", plugin: "gtd-sidebar", filename: "sidebar.png", width: 320, height: 1000 },
  { id: "gtd-sidebar/enable", plugin: "gtd-sidebar", filename: "enable.png", width: 1512, height: 1000 },
  { id: "monokai/app", plugin: "monokai", filename: "app.png", width: 1512, height: 1000 },
] as const;

const specById = new Map(PLUGIN_SCREENSHOT_FIXTURES.map((spec) => [spec.id, spec]));

function usage(): string {
  return `Recapture high-density foreground fixtures from production bb UI.

Usage:
  bun run screenshots:fixtures [options]

Options:
  --plugin <id>       Capture one plugin's fixtures. Repeat for several.
  --output-dir <path> Write <plugin>/<filename> there instead of docs/media.
  --list              Print fixture ids and DPR-3 dimensions.
  --help              Show this help.

The live bb URL comes from BB_SERVER_URL. Output density: DPR ${DPR}.`;
}

function appUrl(path: string): string {
  const base = process.env.BB_SERVER_URL;
  if (!base) throw new Error("BB_SERVER_URL is not set; run this inside a bb thread");
  return new URL(path, base).href;
}

function outputPath(spec: FixtureSpec, outputDir: string | null): string {
  if (!outputDir) {
    return join(ROOT, "plugins", spec.plugin, "docs", "media", spec.filename);
  }
  const directory = isAbsolute(outputDir) ? outputDir : resolve(ROOT, outputDir);
  return join(directory, spec.plugin, spec.filename);
}

function rpcResult(result: unknown): { ok: true; result: unknown } {
  return { ok: true, result };
}

async function fulfillRpc(route: Route, result: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(rpcResult(result)),
  });
}

async function fulfillJson(route: Route, result: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(result),
  });
}

async function mockAgentProxy(context: BrowserContext): Promise<void> {
  const status = {
    state: "running",
    pid: 15_859,
    port: 8317,
    installedVersion: "v7.2.128@bd34ceca0420",
    crashCount: 0,
    lastExit: null,
    endpoints: {
      openai: "http://127.0.0.1:8317/v1",
      anthropic: "http://127.0.0.1:8317",
      gemini: "http://127.0.0.1:8317/v1beta",
    },
    service: {
      manager: "launchd",
      label: "com.bb.plugin.agent-proxy",
      definitionPath: "/Users/example/Library/LaunchAgents/com.bb.plugin.agent-proxy.plist",
      loaded: true,
    },
    source: { repository: "router-for-me/CLIProxyAPI", branch: "latest", error: null },
    latest: { version: "v7.2.128@bd34ceca0420", checkedAt: FIXED_TIME.valueOf() },
  };
  const endpoints = {
    ...status.endpoints,
    apiKey: "sk-local-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  };
  const agentsStatus = {
    claude: {
      applied: false,
      canRestore: true,
      settingsPath: "/Users/example/.claude/settings.json",
      lastBackup: "/Users/example/.bb/plugins/agent-proxy/backups/claude-settings.json.2026-08-11T08-00-00-000Z",
    },
    codex: {
      codexHomePath: "/Users/example/.bb/plugins/agent-proxy/agents/codex-home",
      generated: false,
      envKey: "OPENAI_API_KEY",
    },
  };
  await context.route("**/api/v1/plugins/agent-proxy/rpc/*", async (route) => {
    const method = new URL(route.request().url()).pathname.split("/").at(-1);
    if (method === "status") await fulfillRpc(route, status);
    else if (method === "endpoints") await fulfillRpc(route, endpoints);
    else if (method === "agentsStatus") await fulfillRpc(route, agentsStatus);
    else await route.continue();
  });
}

function annotationFixture() {
  return {
    id: "screenshot-copy-buttons",
    comment: "change this button to white",
    elementPath: "multi-select",
    timestamp: FIXED_TIME.valueOf(),
    x: 86.64,
    y: 606,
    element: "4 elements: button \"Copy\", button \"Copy\", button \"Copy\", button \"Copy\"",
    boundingBox: { x: 1281.84375, y: 417.125, width: 56.15625, height: 206 },
    cssClasses: "inline-flex, items-center, justify-center, rounded-md, border, px-3, text-xs",
    computedStyles: "color: rgb(189, 189, 184); background-color: transparent; border-color: rgb(60, 60, 60); font-size: 12px; font-weight: 500; font-family: Inter Variable, Inter, sans-serif; width: 56px; height: 32px",
    accessibility: "focusable",
    nearbyText: "Copy",
    nearbyElements: "div.min-w-0",
    fullPath: "body.bb-app-shell > div#root > main > div[data-bb-plugin=agent-proxy] main button",
    isMultiSelect: true,
    kind: "feedback",
    status: "pending",
    thread: [],
    sessionId: "ses_screenshot",
    bb: {
      route: "/plugins/agent-proxy/agent-proxy",
      pluginId: "agent-proxy",
      surface: "navPanel",
      threadId: null,
      projectId: null,
      routeLabel: "agent-proxy panel",
    },
    createdAt: FIXED_TIME.toISOString(),
    updatedAt: FIXED_TIME.toISOString(),
    resolution: null,
    seq: 1,
  };
}

async function mockAgentation(
  context: BrowserContext,
  options: { toolbarAnnotation?: boolean; stagedAnnotation?: boolean },
): Promise<void> {
  const annotation = annotationFixture();
  await context.route("**/api/v1/plugins/agentation/rpc/openSession", async (route) => {
    const input = route.request().postDataJSON() as {
      url: string;
      route: string;
      title: string | null;
      threadId: string | null;
      projectId: string | null;
    };
    const annotations = options.toolbarAnnotation && input.route === annotation.bb.route
      ? [annotation]
      : [];
    await fulfillRpc(route, {
      session: {
        id: "ses_screenshot",
        url: input.url,
        route: input.route,
        title: input.title,
        status: "active",
        threadId: input.threadId,
        projectId: input.projectId,
        createdAt: FIXED_TIME.toISOString(),
        updatedAt: FIXED_TIME.toISOString(),
      },
      annotations,
      cursor: 1,
      config: { toolbarEnabled: true },
    });
  });
  await context.route("**/api/v1/plugins/agentation/rpc/pullSession", (route) =>
    fulfillRpc(route, {
      cursor: 1,
      changed: false,
      annotations: options.toolbarAnnotation ? [annotation] : [],
      config: { toolbarEnabled: true },
    }));
  await context.route("**/api/v1/plugins/agentation/rpc/listStagedAnnotations", (route) =>
    fulfillRpc(route, { annotations: options.stagedAnnotation ? [annotation] : [] }));
}

function changeSet(
  additions: number,
  deletions: number,
  path: string,
) {
  return {
    additions,
    deletions,
    files: [{
      path,
      previousPath: null,
      status: "modified",
      additions,
      deletions,
    }],
    truncated: false,
  };
}

function stackFixture() {
  const layers = [
    [23, "docs(agents): add commit guidance", 28, 2, ".dotfiles/.agents/instructions/shared.md"],
    [24, "chore(claude): disable generated attribution", 1, 13, ".dotfiles/.claude/settings.json"],
    [25, "chore(editor): update workspace preferences", 3, 4, ".dotfiles/.config/vscode/settings.json"],
    [26, "feat(skills): add GitHub Actions authoring guidance", 152, 0, ".dotfiles/.agents/skills/gh-actions-create/SKILL.md"],
    [27, "docs(skills): keep GitHub issues at the interface", 46, 9, ".dotfiles/.agents/skills/gh-write-issue/SKILL.md"],
    [28, "docs(skills): clarify BB testing targets", 24, 23, ".dotfiles/.agents/skills/bb-plugin-testing/SKILL.md"],
    [29, "chore(skills): retire Screen Studio editing guidance", 0, 297, ".dotfiles/.agents/skills/editing-screenstudio/SKILL.md"],
  ] as const;
  return {
    stack: {
      trunk: "main",
      currentBranch: "scott/chore-retire-screen-studio-guidance",
      branches: layers.map(([number, title, additions, deletions, path]) => ({
        name: `scott/${title.split(": ")[1]!.replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "")}`,
        isCurrent: number === 29,
        isMerged: false,
        isQueued: false,
        needsRebase: false,
        hasStash: false,
        stashCount: 0,
        pr: {
          number,
          url: `https://github.com/example/dotfiles/pull/${number}`,
          state: "OPEN",
          title,
          isDraft: true,
          metadataStale: false,
        },
        diff: number === 29
          ? {
              additions: 0,
              deletions: 297,
              files: [
                {
                  path: ".dotfiles/.agents/skills/editing-screenstudio/references/demo.md",
                  previousPath: null,
                  status: "deleted",
                  additions: 0,
                  deletions: 121,
                },
                {
                  path,
                  previousPath: null,
                  status: "deleted",
                  additions: 0,
                  deletions: 176,
                },
              ],
              truncated: false,
            }
          : changeSet(additions, deletions, path),
        aheadOfRemote: 0,
        behindRemote: 0,
      })),
      trunkBehind: 0,
      prunableBranchCount: 0,
    },
    workspacePath: "/Users/example/git/dotfiles",
    error: null,
    checkoutWarning: null,
    pending: null,
    defaultBranch: "main",
    branchPrefix: "scott/",
    detectedBranchPrefix: "scott/",
    settings: { branchPrefix: "scott/", conventionalCommits: true },
    fetchedAt: FIXED_TIME.valueOf(),
  };
}

async function mockStack(context: BrowserContext): Promise<void> {
  await context.route("**/api/v1/plugins/gh-stack/rpc/getStack", (route) =>
    fulfillRpc(route, stackFixture()));
}

async function mockAmp(context: BrowserContext, options: { orb?: boolean; oracle?: boolean }): Promise<void> {
  if (options.orb) {
    await context.route("**/api/v1/plugins/amp/rpc/getOrbUsage", (route) =>
      fulfillRpc(route, {
        state: "active",
        ampThreadId: "T-019fefe1-f9b0-75c3-ad24-289bd4647cb4",
        syncCommand: "amp sync T-019fefe1-f9b0-75c3-ad24-289bd4647cb4",
      }));
  }
  if (options.oracle) {
    await context.route("**/api/v1/plugins/amp/rpc/getOracleReport", (route) =>
      fulfillRpc(route, {
        report: {
          id: "11111111-1111-4111-8111-111111111111",
          request: "Answer this narrowly and directly: what is 2 + 2? Briefly state the result and verify it using elementary arithmetic.",
          response: "2 + 2 = 4. Starting at 2 and adding two units gives 3, then 4.",
          status: "completed",
          trace: [],
          createdAt: FIXED_TIME.toISOString(),
        },
        error: null,
      }));
  }
}

const STACK_REPORT = `# Stack submitted

Created a seven-layer stack, bottom to top:

1. [PR #23 — \`docs(agents): add commit guidance\`](https://github.com/example/dotfiles/pull/23)
2. [PR #24 — \`chore(claude): disable generated attribution\`](https://github.com/example/dotfiles/pull/24)
3. [PR #25 — \`chore(editor): update workspace preferences\`](https://github.com/example/dotfiles/pull/25)
4. [PR #26 — \`feat(skills): add GitHub Actions authoring guidance\`](https://github.com/example/dotfiles/pull/26)
5. [PR #27 — \`docs(skills): keep GitHub issues at the interface\`](https://github.com/example/dotfiles/pull/27)
6. [PR #28 — \`docs(skills): clarify BB testing targets\`](https://github.com/example/dotfiles/pull/28)
7. [PR #29 — \`chore(skills): retire Screen Studio editing guidance\`](https://github.com/example/dotfiles/pull/29)

All PRs are drafts. \`gh stack view --json\` confirms the correct parent chain with no layer that needs a rebase.

## Verification

- Ran \`mise run check\` on clean \`main\` before the split.
- Ran \`mise run check\` on every layer before its commit.
- Byte-compared all ten changed paths against the original snapshot: pass.
- Working tree is clean.`;

interface ThreadCaptureFixture {
  id: string;
  projectId: string;
  title: string;
  titleFallback: string;
  messages: readonly { role: "assistant" | "user"; text: string }[];
  tabs?: readonly Record<string, unknown>[];
}

const THREAD_CAPTURE_FIXTURES: Record<string, ThreadCaptureFixture> = {
  idle: {
    id: IDLE_THREAD_ID,
    projectId: DEFAULT_PROJECT_ID,
    title: "Screenshot fixture",
    titleFallback: "Screenshot fixture",
    messages: [],
  },
  oracle: {
    id: ORACLE_THREAD_ID,
    projectId: DEFAULT_PROJECT_ID,
    title: "Consult Oracle for simple sum",
    titleFallback: "/orb consult the oracle on what is 2 + 2",
    messages: [
      { role: "user", text: "/orb consult the oracle on what is 2 + 2" },
      {
        role: "assistant",
        text: "::amp-oracle{reportId=\"11111111-1111-4111-8111-111111111111\"}\n\nThe Oracle says: **2 + 2 = 4**.",
      },
    ],
  },
  stack: {
    id: STACK_THREAD_ID,
    projectId: STACK_PROJECT_ID,
    title: "Build a reviewable stack",
    titleFallback: "Build a reviewable stack",
    messages: [
      { role: "user", text: "Split this change into a reviewable stack." },
      { role: "assistant", text: STACK_REPORT },
    ],
    tabs: [
      { id: "thread-info:thread-info:none", kind: "thread-info" },
      {
        actionId: "stack",
        id: "plugin-panel:gh-stack%3Astack%3A:none",
        kind: "plugin-panel",
        paramsJson: null,
        pluginId: "gh-stack",
        title: "GitHub Stack",
      },
      { id: "new-tab:new-tab:none", kind: "new-tab" },
    ],
  },
};

function captureThreadMetadata(fixture: ThreadCaptureFixture) {
  const createdAt = FIXED_TIME.valueOf() - 3_600_000;
  return {
    id: fixture.id,
    projectId: fixture.projectId,
    environmentId: `env_${fixture.id.slice(4)}`,
    providerId: "acp-amp",
    title: fixture.title,
    titleFallback: fixture.titleFallback,
    sectionId: null,
    status: "idle",
    parentThreadId: null,
    sourceThreadId: null,
    originKind: null,
    childOrigin: null,
    originPluginId: null,
    visibility: "visible",
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    lastReadAt: FIXED_TIME.valueOf(),
    latestAttentionAt: FIXED_TIME.valueOf(),
    createdAt,
    updatedAt: FIXED_TIME.valueOf(),
    runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
    activeBackgroundAgentCount: 0,
    canSpawnChild: true,
    environment: {
      id: `env_${fixture.id.slice(4)}`,
      name: null,
      projectId: fixture.projectId,
      hostId: "host_screenshot",
      path: fixture.projectId === STACK_PROJECT_ID
        ? "/Users/example/git/dotfiles"
        : "/Users/example/git/bb-plugins",
      managed: false,
      isGitRepo: true,
      isWorktree: false,
      branchName: "main",
      baseBranch: null,
      defaultBranch: "main",
      mergeBaseBranch: null,
      destroyAttemptId: null,
      retireRequestedAt: null,
      workspaceProvisionType: "unmanaged",
      status: "ready",
      createdAt,
      updatedAt: FIXED_TIME.valueOf(),
    },
    host: {
      id: "host_screenshot",
      name: "Screenshot Host",
      type: "persistent",
      status: "connected",
      maxPermissionMode: "full",
      lastSeenAt: FIXED_TIME.valueOf(),
      lastRejectedProtocolVersion: null,
      createdAt,
      updatedAt: FIXED_TIME.valueOf(),
    },
  };
}

function captureTimeline(fixture: ThreadCaptureFixture) {
  const rows = fixture.messages.map((message, index) => {
    const sequence = index + 1;
    const createdAt = FIXED_TIME.valueOf() - (fixture.messages.length - index) * 1_000;
    return {
      id: `${fixture.id}:screenshot:${sequence}`,
      threadId: fixture.id,
      turnId: null,
      sourceSeqStart: sequence,
      sourceSeqEnd: sequence,
      startedAt: createdAt,
      createdAt,
      kind: "conversation",
      role: message.role,
      text: message.text,
      mentions: message.role === "user" ? [] : undefined,
      attachments: message.role === "user"
        ? {
            webImages: 0,
            localImages: 0,
            localFiles: 0,
            imageUrls: [],
            localImagePaths: [],
            localFilePaths: [],
          }
        : null,
      initiator: message.role === "user" ? "user" : undefined,
      senderThreadId: message.role === "user" ? null : undefined,
      systemMessageKind: message.role === "user" ? "unlabeled" : undefined,
      systemMessageSubject: message.role === "user" ? null : undefined,
      turnRequest: message.role === "user"
        ? { isGrouped: false, kind: "message", status: "accepted" }
        : null,
    };
  });
  return {
    maxSeq: rows.length,
    rows,
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    pendingTodos: null,
    goal: null,
    modelFallback: null,
    timelinePage: {
      kind: "latest",
      segmentLimit: 20,
      returnedSegmentCount: rows.length > 0 ? 1 : 0,
      hasOlderRows: false,
      olderCursor: null,
    },
  };
}

async function mockThread(
  context: BrowserContext,
  fixture: ThreadCaptureFixture,
): Promise<void> {
  const environmentId = `env_${fixture.id.slice(4)}`;
  await context.route(`**/api/v1/environments/${environmentId}/status?**`, (route) =>
    fulfillJson(route, {
      outcome: "available",
      workspace: {
        workingTree: {
          insertions: 0,
          deletions: 0,
          files: [],
          hasUncommittedChanges: false,
          state: "clean",
        },
        checkout: {
          kind: "branch",
          branchName: "main",
          headSha: "1111111111111111111111111111111111111111",
        },
        branch: { currentBranch: "main", defaultBranch: "main" },
        mergeBase: {
          insertions: 0,
          deletions: 0,
          files: [],
          mergeBaseBranch: "main",
          baseRef: "1111111111111111111111111111111111111111",
          aheadCount: 0,
          behindCount: 0,
          hasCommittedUnmergedChanges: false,
          commits: [],
        },
      },
    }));
  await context.route(`**/api/v1/environments/${environmentId}/pull-request`, (route) =>
    fulfillJson(route, { outcome: "absent" }));
  const base = `/api/v1/threads/${fixture.id}`;
  const responses = new Map<string, unknown>([
    [base, captureThreadMetadata(fixture)],
    [`${base}/timeline`, captureTimeline(fixture)],
    [`${base}/conversation-outline`, {
      items: fixture.messages.map((message, index) => ({
        id: `${fixture.id}:screenshot:${index + 1}`,
        role: message.role,
        preview: message.text.replaceAll(/\s+/g, " ").slice(0, 200),
        attachmentSummary: null,
      })),
      maxSeq: fixture.messages.length,
    }],
    [`${base}/default-execution-options`, {
      model: "medium",
      permissionMode: "full",
      reasoningLevel: "medium",
      serviceTier: "default",
      source: "client/turn/requested",
    }],
    [`${base}/interactions`, []],
    [`${base}/prompt-history`, []],
    [`${base}/queued-messages`, []],
    [`${base}/tabs`, { revision: 1, tabs: fixture.tabs ?? [] }],
    [`${base}/thread-storage/files`, {
      files: [],
      truncated: false,
      storageRootPath: `/Users/example/.bb/thread-storage/${fixture.id}`,
    }],
  ]);
  await context.route(new RegExp(`/api/v1/threads/${fixture.id}(?:[/?]|$)`), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const response = responses.get(path);
    if (request.method() !== "GET" || response === undefined) {
      await route.abort("blockedbyclient");
      return;
    }
    await fulfillJson(route, response);
  });
}

async function mockNewThreadShell(context: BrowserContext): Promise<void> {
  const defaultExecutionOptions = {
    providerId: "acp-amp",
    model: "high",
    reasoningLevel: "xhigh",
    permissionMode: "full",
    serviceTier: "fast",
  };
  await context.route("**/api/v1/sidebar-bootstrap", (route) =>
    fulfillJson(route, {
      sections: [],
      projects: [{
        id: DEFAULT_PROJECT_ID,
        kind: "standard",
        name: "bb-plugins",
        gitRemoteUrl: "https://github.com/example/bb-plugins.git",
        createdAt: FIXED_TIME.valueOf() - 86_400_000,
        updatedAt: FIXED_TIME.valueOf(),
        sources: [],
        threads: [],
        defaultExecutionOptions,
      }],
      personalProject: {
        id: "proj_personal",
        kind: "personal",
        name: "Personal",
        gitRemoteUrl: null,
        createdAt: FIXED_TIME.valueOf() - 86_400_000,
        updatedAt: FIXED_TIME.valueOf(),
        sources: [],
        threads: [],
        defaultExecutionOptions,
      },
    }));
  await context.route(new RegExp("/api/v1/threads(?:[?]|$)"), (route) =>
    fulfillJson(route, []));
  await context.route("**/api/v1/projects/proj_personal/prompt-history", (route) =>
    fulfillJson(route, []));
}

function sidebarThread(
  id: string,
  title: string,
  updatedMinutesAgo: number,
  overrides: Record<string, unknown> = {},
) {
  const updatedAt = FIXED_TIME.valueOf() - updatedMinutesAgo * 60_000;
  return {
    id,
    projectId: DEFAULT_PROJECT_ID,
    environmentId: "env_screenshot",
    providerId: "acp-amp",
    title,
    titleFallback: title,
    sectionId: null,
    status: "idle",
    parentThreadId: null,
    sourceThreadId: null,
    originKind: null,
    childOrigin: null,
    originPluginId: null,
    visibility: "visible",
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    lastReadAt: updatedAt,
    latestAttentionAt: updatedAt,
    createdAt: updatedAt - 3_600_000,
    updatedAt,
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    pinSortKey: null,
    environmentBranchName: "main",
    environmentHostId: "host_screenshot",
    environmentName: null,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
    runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
    ...overrides,
  };
}

function settledSidebarThread(id: string, title: string, minutesAgo: number) {
  const settledAt = FIXED_TIME.valueOf() - minutesAgo * 60_000;
  return {
    id,
    settledAt,
    projectId: DEFAULT_PROJECT_ID,
    title,
    titleFallback: title,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "acp-amp",
    status: "idle",
    hasPendingInteraction: false,
    isPinned: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    createdAt: settledAt - 3_600_000,
    updatedAt: settledAt,
    lastReadAt: settledAt,
    latestAttentionAt: settledAt,
  };
}

async function mockGtdSidebar(context: BrowserContext): Promise<void> {
  const inbox = [
    sidebarThread("thr_capture_active", "Prepare bb plugin monorepo", 0, {
      status: "active",
      lastReadAt: FIXED_TIME.valueOf() - 3_600_000,
      runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
      activity: {
        activeBackgroundAgentCount: 1,
        activeBackgroundCommandCount: 0,
        activeGoalCount: 0,
        activePlanModeCount: 0,
        activeWorkflowCount: 1,
      },
    }),
    sidebarThread("thr_capture_snoozed_1", "BB plugin ideas", 480),
    sidebarThread("thr_capture_snoozed_2", "Investigate repeated AM occurrences", 480),
    sidebarThread("thr_capture_snoozed_3", "Optimize BB app performance", 480),
    sidebarThread("thr_capture_snoozed_4", "Create Agentation plugin for BB", 2_880),
  ];
  const project = {
    id: DEFAULT_PROJECT_ID,
    kind: "standard",
    name: "bb-plugins",
    gitRemoteUrl: "https://github.com/smsunarto/bb-plugins.git",
    createdAt: FIXED_TIME.valueOf() - 86_400_000,
    updatedAt: FIXED_TIME.valueOf(),
    sources: [],
    threads: inbox,
    defaultExecutionOptions: null,
  };
  const personalProject = {
    id: "proj_personal",
    kind: "personal",
    name: "Personal",
    gitRemoteUrl: null,
    createdAt: FIXED_TIME.valueOf() - 86_400_000,
    updatedAt: FIXED_TIME.valueOf(),
    sources: [],
    threads: [],
    defaultExecutionOptions: null,
  };
  const settledThreads = [
    settledSidebarThread("thr_capture_settled_1", "commit and sync", 32),
    settledSidebarThread("thr_capture_settled_2", "Investigate bb-testing app usage", 50),
    settledSidebarThread("thr_capture_settled_3", "Fix agent proxy reset defaults", 16),
    settledSidebarThread("thr_capture_settled_4", "Update theme color palette", 41),
  ];
  await context.route("**/api/v1/sidebar-bootstrap", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ sections: [], projects: [project], personalProject }),
  }));
  await context.route("**/api/v1/threads", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(inbox),
  }));
  await context.route("**/api/v1/plugins/gtd-sidebar/rpc/*", async (route) => {
    const method = new URL(route.request().url()).pathname.split("/").at(-1);
    if (method === "listProviders") {
      await fulfillRpc(route, {
        providers: [
          { id: "acp-amp", displayName: "Amp", logoUrl: "/api/v1/system/providers/acp-amp/logo" },
        ],
      });
    } else if (method === "listLifecycle") {
      await fulfillRpc(route, {
        rows: inbox.slice(1).map((thread, index) => ({
          threadId: thread.id,
          settledAt: null,
          snoozedUntil: FIXED_TIME.valueOf() + 86_400_000,
          snoozedAt: FIXED_TIME.valueOf() - (index + 1) * 60_000,
        })).concat(settledThreads.map((thread) => ({
          threadId: thread.id,
          settledAt: thread.settledAt,
          snoozedUntil: null,
          snoozedAt: null,
        }))),
      });
    } else if (method === "listSettledThreads") {
      await fulfillRpc(route, { threads: settledThreads });
    } else await route.continue();
  });
}

async function createContext(
  browser: Browser,
  viewport = APP_VIEWPORT,
): Promise<BrowserContext> {
  const context = await createScreenshotContext(browser, {
    viewport,
    dpr: DPR,
  });
  await context.addInitScript(
    ({ order, orderKey, provider, providerKey }) => {
      localStorage.setItem(providerKey, JSON.stringify(provider));
      localStorage.setItem(orderKey, JSON.stringify(order));
    },
    {
      order: SIDEBAR_PLUGIN_ORDER.map(({ id }) => id),
      orderKey: SIDEBAR_PLUGIN_ORDER_KEY,
      provider: SIDEBAR_PROVIDER,
      providerKey: SIDEBAR_PROVIDER_KEY,
    },
  );
  await context.route("**/api/v1/system/execution-options?**", (route) =>
    fulfillJson(route, EXECUTION_OPTIONS));
  await context.route("**/api/v1/hosts", (route) =>
    fulfillJson(route, [SCREENSHOT_HOST]));
  await context.route("**/api/v1/hosts/host_screenshot/provider-clis/status", (route) =>
    fulfillJson(route, PROVIDER_CLI_STATUS));
  return context;
}

const STABLE_STYLES = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
  [data-bb-agentation-host] { display: none !important; }
`;

async function settle(page: Page, options: { showAgentation?: boolean } = {}): Promise<void> {
  await page.addStyleTag({
    content: options.showAgentation
      ? STABLE_STYLES.replace("[data-bb-agentation-host] { display: none !important; }", "")
      : STABLE_STYLES,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode()));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

async function navigate(
  page: Page,
  path: string,
  ready: Locator,
  options: { showAgentation?: boolean } = {},
): Promise<void> {
  await page.goto(appUrl(path), { waitUntil: "domcontentloaded" });
  const sidebarProvider = await page.evaluate(
    (key) => localStorage.getItem(key),
    SIDEBAR_PROVIDER_KEY,
  );
  if (sidebarProvider !== JSON.stringify(SIDEBAR_PROVIDER)) {
    throw new Error(`sidebar provider is ${sidebarProvider}; expected ${SIDEBAR_PROVIDER}`);
  }
  await ready.waitFor({ state: "visible" });
  await page
    .getByRole("combobox", { name: /^Project scope:/ })
    .waitFor({ state: "attached" });
  await settle(page, options);
}

async function ensureHostSidebarClosed(page: Page): Promise<void> {
  const pluginSidebar = page.locator("aside").filter({ hasText: "Running · :8317" });
  await pluginSidebar.waitFor({ state: "visible" });
  const box = await pluginSidebar.boundingBox();
  if (box && box.x > 1) {
    await page.locator('button[data-sidebar="trigger"]').click({ force: true });
    await page.waitForFunction(() => {
      const sidebars = [...document.querySelectorAll("aside")];
      const sidebar = sidebars.find((element) => element.textContent?.includes("Running · :8317"));
      return sidebar?.getBoundingClientRect().x === 0;
    });
  }
}

async function ensureHostSidebarOpen(page: Page): Promise<void> {
  const pluginSidebar = page.locator("aside").filter({ hasText: "Running · :8317" });
  await pluginSidebar.waitFor({ state: "visible" });
  const box = await pluginSidebar.boundingBox();
  if (box && box.x < 1) {
    await page.locator('button[data-sidebar="trigger"]').click({ force: true });
    await page.waitForFunction(() => {
      const sidebars = [...document.querySelectorAll("aside")];
      const sidebar = sidebars.find((element) => element.textContent?.includes("Running · :8317"));
      return (sidebar?.getBoundingClientRect().x ?? 0) > 1;
    });
  }
}

async function hideWorkingTreeStatus(page: Page): Promise<void> {
  const status = page.getByText(/^(?:Uncommitted|Committed) ·/).first();
  if (await status.count()) {
    await status.evaluate((element) => {
      const section = element.closest("section");
      if (section instanceof HTMLElement) section.style.display = "none";
    });
  }
}

async function assertSidebarNavigation(page: Page): Promise<void> {
  const expected = [
    SIDEBAR_BUILTIN_LEAD_LABEL,
    ...SIDEBAR_PLUGIN_ORDER.map(({ label }) => label),
  ];
  await page.waitForFunction((orderedLabels) => {
    const rows = document.querySelectorAll(
      '[data-testid="plugin-nav-sidebar-items"] > .bb-sidebar-hover-actions-row',
    );
    const actual = [...rows].map((row) => row.textContent?.trim());
    return actual.length === orderedLabels.length &&
      actual.every((label, index) => label === orderedLabels[index]);
  }, expected);
}

function centeredClip(
  box: { x: number; width: number },
  spec: FixtureSpec,
  y: number,
): ScreenshotClip {
  return {
    x: Math.round(box.x + (box.width - spec.width) / 2),
    y,
    width: spec.width,
    height: spec.height,
  };
}

type WriteCapture = (
  page: Page,
  spec: FixtureSpec,
  clip?: ScreenshotClip,
) => Promise<void>;

function fixtureWriter(
  batch: ScreenshotBatch,
  outputDir: string | null,
): WriteCapture {
  return (page, spec, clip) =>
    batch.capture(page, {
      id: spec.id,
      output: outputPath(spec, outputDir),
      expected: { width: spec.width * DPR, height: spec.height * DPR },
      clip,
    });
}

async function captureAgentProxy(browser: Browser, writeCapture: WriteCapture): Promise<void> {
  const context = await createContext(browser, { width: 596, height: 500 });
  try {
    await mockAgentProxy(context);
    await mockAgentation(context, {});
    const page = await createScreenshotPage(context, { fixedTime: FIXED_TIME });
    const home = specById.get("agent-proxy/home")!;
    await navigate(page, "/plugins/agent-proxy/agent-proxy", page.getByText("CLIProxyAPI core", { exact: true }));
    await ensureHostSidebarClosed(page);
    await settle(page);
    await writeCapture(page, home);

    const agents = specById.get("agent-proxy/agents")!;
    await navigate(page, "/plugins/agent-proxy/agent-proxy/agents", page.getByText("Anything OpenAI-compatible", { exact: true }));
    await ensureHostSidebarClosed(page);
    await settle(page);
    await writeCapture(page, agents);
  } finally {
    await context.close();
  }
}

async function captureAgentation(browser: Browser, writeCapture: WriteCapture): Promise<void> {
  const captureContext = await createContext(browser);
  try {
    await mockAgentProxy(captureContext);
    await mockAgentation(captureContext, { toolbarAnnotation: true });
    const page = await createScreenshotPage(captureContext, { fixedTime: FIXED_TIME });
    await navigate(
      page,
      "/plugins/agent-proxy/agent-proxy",
      page.getByText("Local endpoints", { exact: true }),
      { showAgentation: true },
    );
    await ensureHostSidebarOpen(page);
    const marker = page.locator("[data-annotation-marker]");
    const start = page.locator('[data-agentation-toolbar] [title="Start feedback mode"]');
    await start.click();
    try {
      await marker.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      const stop = page.locator('[data-agentation-toolbar] [title="Stop feedback mode"]');
      if (await stop.count()) await stop.click();
      await start.waitFor({ state: "visible" });
      await start.click();
      await marker.waitFor({ state: "visible" });
    }
    await marker.hover();
    const spec = specById.get("agentation/capture")!;
    await writeCapture(page, spec, { x: 584, y: 300, width: spec.width, height: spec.height });
  } finally {
    await captureContext.close();
  }

  const stagingContext = await createContext(browser);
  try {
    await mockAgentation(stagingContext, { stagedAnnotation: true });
    await mockThread(stagingContext, THREAD_CAPTURE_FIXTURES.idle!);
    const page = await createScreenshotPage(stagingContext, { fixedTime: FIXED_TIME });
    await navigate(
      page,
      `/projects/${DEFAULT_PROJECT_ID}/threads/${IDLE_THREAD_ID}`,
      page.getByRole("button", { name: "Send 1 to this thread", exact: true }),
    );
    await hideWorkingTreeStatus(page);
    await settle(page);
    const shell = await page.locator(".chat-prompt-box").boundingBox();
    if (!shell) throw new Error("Agentation staging composer has no bounding box");
    const spec = specById.get("agentation/staging")!;
    await writeCapture(
      page,
      spec,
      centeredClip(shell, spec, APP_VIEWPORT.height - spec.height),
    );
  } finally {
    await stagingContext.close();
  }
}

async function captureAmp(browser: Browser, writeCapture: WriteCapture): Promise<void> {
  const promptContext = await createContext(browser);
  try {
    await mockAgentation(promptContext, {});
    await mockNewThreadShell(promptContext);
    const page = await createScreenshotPage(promptContext, { fixedTime: FIXED_TIME });
    await navigate(page, "/", page.locator("[data-promptbox]"));
    const editor = page.locator('[data-promptbox] [contenteditable="true"]');
    await editor.fill("/orb consult the oracle on what is 2 + 2");
    await page.locator(".amp-orb-directive-highlight").waitFor({ state: "visible" });
    await page.getByText("Loading models…", { exact: true }).waitFor({ state: "hidden" });
    await settle(page);
    const shell = await page.locator("[data-promptbox-shell]").boundingBox();
    if (!shell) throw new Error("Amp prompt composer has no bounding box");
    const spec = specById.get("amp/orb-prompt")!;
    await writeCapture(
      page,
      spec,
      {
        x: Math.round(shell.x + shell.width / 2 - spec.width / 2),
        y: Math.max(0, Math.round(shell.y - 24)),
        width: spec.width,
        height: spec.height,
      },
    );
  } finally {
    await promptContext.close();
  }

  const orbContext = await createContext(browser);
  try {
    await mockAgentation(orbContext, {});
    await mockAmp(orbContext, { orb: true });
    await mockThread(orbContext, THREAD_CAPTURE_FIXTURES.idle!);
    const page = await createScreenshotPage(orbContext, { fixedTime: FIXED_TIME });
    await navigate(
      page,
      `/projects/${DEFAULT_PROJECT_ID}/threads/${IDLE_THREAD_ID}`,
      page.locator(".amp-orb-status-pill"),
    );
    await page.getByText("Loading models…", { exact: true }).waitFor({ state: "hidden" });
    await hideWorkingTreeStatus(page);
    await settle(page);
    const shell = await page.locator(".chat-prompt-box").boundingBox();
    if (!shell) throw new Error("Amp Orb composer has no bounding box");
    const spec = specById.get("amp/orb-bar")!;
    await writeCapture(
      page,
      spec,
      centeredClip(shell, spec, APP_VIEWPORT.height - spec.height),
    );
  } finally {
    await orbContext.close();
  }

  const oracleContext = await createContext(browser);
  try {
    await mockAgentation(oracleContext, {});
    await mockAmp(oracleContext, { oracle: true });
    await mockThread(oracleContext, THREAD_CAPTURE_FIXTURES.oracle!);
    const page = await createScreenshotPage(oracleContext, { fixedTime: FIXED_TIME });
    const card = page.locator("details").filter({
      hasText: "2 + 2 = 4. Starting at 2 and adding two units gives 3, then 4.",
    });
    await navigate(
      page,
      `/projects/${DEFAULT_PROJECT_ID}/threads/${ORACLE_THREAD_ID}`,
      card,
    );
    await card.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await settle(page);
    const box = await card.boundingBox();
    if (!box) throw new Error("Oracle result has no bounding box");
    const spec = specById.get("amp/oracle-card")!;
    await writeCapture(page, spec, {
      x: Math.round(box.x + box.width / 2 - spec.width / 2),
      y: Math.max(0, Math.round(box.y - 112)),
      width: spec.width,
      height: spec.height,
    });
  } finally {
    await oracleContext.close();
  }
}

async function showRightPanel(page: Page): Promise<void> {
  const show = page.getByRole("button", { name: /Show right panel/ });
  if (await show.count()) await show.click();
  await page.locator("#thread-detail-secondary-panel").waitFor({ state: "visible" });
}

async function captureGhStack(browser: Browser, writeCapture: WriteCapture): Promise<void> {
  const newTabContext = await createContext(browser);
  try {
    await mockAgentation(newTabContext, {});
    await mockThread(newTabContext, THREAD_CAPTURE_FIXTURES.stack!);
    const page = await createScreenshotPage(newTabContext, { fixedTime: FIXED_TIME });
    await navigate(
      page,
      `/projects/${STACK_PROJECT_ID}/threads/${STACK_THREAD_ID}`,
      page.getByText("Stack submitted", { exact: true }),
    );
    await showRightPanel(page);
    await page.getByRole("button", { name: /Open new tab/ }).click();
    await page.getByPlaceholder("Search files").waitFor({ state: "visible" });
    await settle(page);
    const panel = await page.locator("#thread-detail-secondary-panel").boundingBox();
    if (!panel) throw new Error("New tab panel has no bounding box");
    const spec = specById.get("gh-stack/new-tab")!;
    await writeCapture(page, spec, {
      x: Math.round(panel.x + (panel.width - spec.width) / 2),
      y: 0,
      width: spec.width,
      height: spec.height,
    });
  } finally {
    await newTabContext.close();
  }

  const reportContext = await createContext(browser);
  try {
    await mockAgentation(reportContext, {});
    await mockThread(reportContext, THREAD_CAPTURE_FIXTURES.stack!);
    const page = await createScreenshotPage(reportContext, { fixedTime: FIXED_TIME });
    const heading = page.getByText("Stack submitted", { exact: true });
    await navigate(
      page,
      `/projects/${STACK_PROJECT_ID}/threads/${STACK_THREAD_ID}`,
      heading,
    );
    await heading.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await settle(page);
    const box = await heading.boundingBox();
    if (!box) throw new Error("Magic Stack report has no bounding box");
    const spec = specById.get("gh-stack/magic-stack-report")!;
    await writeCapture(page, spec, {
      x: Math.round(box.x + box.width / 2 - spec.width / 2),
      y: Math.min(
        APP_VIEWPORT.height - spec.height,
        Math.max(0, Math.round(box.y - 106)),
      ),
      width: spec.width,
      height: spec.height,
    });
  } finally {
    await reportContext.close();
  }

  const resultContext = await createContext(browser);
  try {
    await mockAgentation(resultContext, {});
    await mockStack(resultContext);
    await mockThread(resultContext, THREAD_CAPTURE_FIXTURES.stack!);
    const page = await createScreenshotPage(resultContext, { fixedTime: FIXED_TIME });
    await navigate(
      page,
      `/projects/${STACK_PROJECT_ID}/threads/${STACK_THREAD_ID}`,
      page.getByText("Stack submitted", { exact: true }),
    );
    await showRightPanel(page);
    await page.getByText("GitHub Stack", { exact: true }).click();
    await page.getByText("#29", { exact: true }).waitFor({ state: "visible" });
    await settle(page);
    const panel = await page.locator("#thread-detail-secondary-panel").boundingBox();
    if (!panel) throw new Error("GitHub Stack result panel has no bounding box");
    const spec = specById.get("gh-stack/magic-stack-result")!;
    if (Math.round(panel.width) !== spec.width) {
      throw new Error(`GitHub Stack panel is ${panel.width}px wide; expected ${spec.width}px`);
    }
    await writeCapture(page, spec, {
      x: Math.round(panel.x),
      y: 0,
      width: spec.width,
      height: spec.height,
    });
  } finally {
    await resultContext.close();
  }
}

async function captureMonokai(browser: Browser, writeCapture: WriteCapture): Promise<void> {
  const appContext = await createContext(browser);
  try {
    await mockAgentation(appContext, {});
    await mockStack(appContext);
    await mockGtdSidebar(appContext);
    await mockThread(appContext, THREAD_CAPTURE_FIXTURES.stack!);
    const page = await createScreenshotPage(appContext, { fixedTime: FIXED_TIME });
    await navigate(
      page,
      `/projects/${STACK_PROJECT_ID}/threads/${STACK_THREAD_ID}`,
      page.getByText("Stack submitted", { exact: true }),
    );
    await showRightPanel(page);
    await page.getByText("GitHub Stack", { exact: true }).click();
    await page.getByText("#29", { exact: true }).waitFor({ state: "visible" });
    await assertSidebarNavigation(page);
    await settle(page);
    await writeCapture(page, specById.get("monokai/app")!);
  } finally {
    await appContext.close();
  }
}

async function captureGtdSidebar(browser: Browser, writeCapture: WriteCapture): Promise<void> {
  const context = await createContext(browser);
  try {
    await mockAgentation(context, {});
    await mockGtdSidebar(context);
    const page = await createScreenshotPage(context, { fixedTime: FIXED_TIME });
    await navigate(page, "/", page.getByRole("combobox", { name: /Project scope:/ }));
    await page.getByRole("button").filter({ hasText: "Snoozed" }).click();
    await page.getByRole("button").filter({ hasText: "Settled" }).click();
    await page.getByText("Update theme color palette", { exact: true }).waitFor();
    await assertSidebarNavigation(page);
    await settle(page);
    const spec = specById.get("gtd-sidebar/sidebar")!;
    await writeCapture(page, spec, { x: 0, y: 0, width: spec.width, height: spec.height });
  } finally {
    await context.close();
  }

  const settingsContext = await createContext(browser);
  try {
    await mockAgentation(settingsContext, {});
    const page = await createScreenshotPage(settingsContext, { fixedTime: FIXED_TIME });
    // Not navigate(): /settings swaps the app sidebar for the settings nav, so
    // the project scope picker it waits for never mounts on this route.
    await page.goto(appUrl("/settings/appearance"), { waitUntil: "domcontentloaded" });
    const trigger = page.getByRole("button", { name: "Sidebar thread list" });
    await trigger.waitFor({ state: "visible" });
    const selected = (await trigger.textContent())?.trim();
    if (selected !== SIDEBAR_PROVIDER_TITLE) {
      throw new Error(`Sidebar setting reads ${selected}; expected ${SIDEBAR_PROVIDER_TITLE}`);
    }
    await trigger.click();
    await page
      .getByRole("menuitem")
      .filter({ hasText: SIDEBAR_PROVIDER_TITLE })
      .waitFor({ state: "visible" });
    await settle(page);
    await writeCapture(page, specById.get("gtd-sidebar/enable")!);
  } finally {
    await settingsContext.close();
  }
}

const captures: Record<string, (browser: Browser, writeCapture: WriteCapture) => Promise<void>> = {
  "agent-proxy": captureAgentProxy,
  agentation: captureAgentation,
  amp: captureAmp,
  "gh-stack": captureGhStack,
  "gtd-sidebar": captureGtdSidebar,
  monokai: captureMonokai,
};

async function main(): Promise<void> {
  let options: ScreenshotOptions;
  try {
    options = parseScreenshotArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`plugin-screenshot-fixtures: ${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.list) {
    for (const spec of PLUGIN_SCREENSHOT_FIXTURES) {
      console.log(`${spec.id.padEnd(30)} ${spec.width * DPR}×${spec.height * DPR}`);
    }
    return;
  }
  const requested = options.plugins.length ? options.plugins : Object.keys(captures);
  const unknown = requested.filter((plugin) => !(plugin in captures));
  if (unknown.length > 0) throw new Error(`unknown plugin${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);

  await prepareBbForScreenshots();
  console.log(
    `bb preflight    ${SCREENSHOT_PREFLIGHT_PLUGINS.length} workspace plugins enabled · ${SCREENSHOT_THEME_ID}`,
  );

  const results = await withScreenshotBatch(async (batch) => {
    const browser = await launchScreenshotBrowser();
    try {
      const writeCapture = fixtureWriter(batch, options.outputDir);
      for (const plugin of requested) await captures[plugin]!(browser, writeCapture);
    } finally {
      await browser.close();
    }
  });
  for (const result of results) {
    console.log(
      `${result.id.padEnd(30)} ${relative(ROOT, result.output)}  ${result.width}×${result.height}`,
    );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      `plugin-screenshot-fixtures: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
