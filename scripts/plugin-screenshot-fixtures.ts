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
 *   bun run screenshots:fixtures --plugin agentation
 *   bun run screenshots:fixtures --output-dir /tmp/bb-plugin-fixtures
 */
import { isAbsolute, join, relative, resolve } from "node:path";
import { type Browser, type BrowserContext, type Locator, type Page, type Route } from "playwright";
import {
  createScreenshotContext,
  createScreenshotPage,
  launchScreenshotBrowser,
  parseScreenshotArguments,
  SCREENSHOT_ROOT,
  SIDEBAR_PROVIDER,
  SIDEBAR_PROVIDER_KEY,
  type ScreenshotBatch,
  type ScreenshotClip,
  type ScreenshotOptions,
  withScreenshotBatch,
} from "./plugin-screenshot-runtime";

const ROOT = SCREENSHOT_ROOT;
const DPR = 3;
const APP_VIEWPORT = { width: 1512, height: 1000 } as const;
const FIXED_TIME = new Date("2026-08-13T12:00:00.000Z");
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
] as const;
const DEFAULT_PROJECT_ID = "proj_b25re9h8d7";
const IDLE_THREAD_ID = "thr_fytu99znvt";
const STACK_PROJECT_ID = "proj_dhxdkz286e";
const STACK_THREAD_ID = "thr_cpc9jzpn5j";
const EXECUTION_OPTIONS = {
  providers: [
    {
      available: true,
      capabilities: {
        supportsArchive: false,
        supportsRename: false,
        supportsServiceTier: false,
        supportsUserQuestion: false,
        supportsFork: false,
        supportedPermissionModes: ["accept-edits", "full"],
      },
      composerActions: [{ kind: "skills", trigger: "/" }],
      displayName: "Amp",
      id: "acp-amp",
      logoUrl: "/api/v1/system/providers/acp-amp/logo",
      reasoningLevels: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "ultra", label: "Ultra" },
      ],
    },
  ],
  permissionCeiling: "full",
  models: [
    {
      id: "low",
      model: "low",
      displayName: "Low",
      description: "",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "medium",
      isDefault: false,
    },
    {
      id: "medium",
      model: "medium",
      displayName: "Medium",
      description: "",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "medium",
      isDefault: true,
    },
    {
      id: "high",
      model: "high",
      displayName: "High",
      description: "",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "medium",
      isDefault: false,
    },
    {
      id: "ultra",
      model: "ultra",
      displayName: "Ultra",
      description: "",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "medium",
      isDefault: false,
    },
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
  {
    id: "agentation/capture",
    plugin: "agentation",
    filename: "capture.png",
    width: 873,
    height: 470,
  },
  {
    id: "agentation/staging",
    plugin: "agentation",
    filename: "staging.png",
    width: 749,
    height: 284,
  },
  {
    id: "gtd-sidebar/sidebar",
    plugin: "gtd-sidebar",
    filename: "sidebar.png",
    width: 320,
    height: 1000,
  },
  {
    id: "gtd-sidebar/enable",
    plugin: "gtd-sidebar",
    filename: "enable.png",
    width: 1512,
    height: 1000,
  },
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

Set BB_APP_URL to the selected build's App URL from BB's launcher status.
Output density: DPR ${DPR}.`;
}

export function appUrl(path: string, environment: NodeJS.ProcessEnv = process.env): string {
  const base = environment.BB_APP_URL;
  if (!base) {
    throw new Error(
      "Set BB_APP_URL to the build's App URL, not its Server URL, before capturing fixtures.",
    );
  }
  return new URL(path, base).href;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function assertFixturePrerequisites(
  base: string,
  selected: readonly string[],
): Promise<void> {
  const read = async (path: string): Promise<unknown> => {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Screenshot prerequisite ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const [list, config] = await Promise.all([
    read("/api/v1/plugins"),
    read("/api/v1/system/config"),
  ]);
  if (
    !record(config) ||
    !record(config.appearance) ||
    config.appearance.themeId !== "plugin:monokai:bb-monokai"
  ) {
    throw new Error(
      "Select bb Monokai in the target BB before capturing fixtures (bb theme set plugin:monokai:bb-monokai).",
    );
  }
  if (!record(list) || !Array.isArray(list.plugins))
    throw new Error("Target BB returned no plugin list.");
  const plugins: unknown[] = list.plugins;
  for (const id of new Set([...selected, "monokai", "gtd-sidebar"])) {
    const plugin = plugins.find((value) => record(value) && value.id === id);
    const expected = join(ROOT, "plugins", id);
    if (
      !record(plugin) ||
      plugin.rootDir !== expected ||
      plugin.enabled !== true ||
      plugin.status !== "running"
    ) {
      throw new Error(
        `Fixture plugin ${id} must be running from ${expected}. Use bb plugin install ${expected} and bb plugin enable ${id} on the target BB.`,
      );
    }
  }
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

function annotationFixture() {
  return {
    id: "screenshot-copy-buttons",
    comment: "change this button to white",
    elementPath: "multi-select",
    timestamp: FIXED_TIME.valueOf(),
    x: 86.64,
    y: 606,
    element: '4 elements: button "Copy", button "Copy", button "Copy", button "Copy"',
    boundingBox: { x: 1281.84375, y: 417.125, width: 56.15625, height: 206 },
    cssClasses: "inline-flex, items-center, justify-center, rounded-md, border, px-3, text-xs",
    computedStyles:
      "color: rgb(189, 189, 184); background-color: transparent; border-color: rgb(60, 60, 60); font-size: 12px; font-weight: 500; font-family: Inter Variable, Inter, sans-serif; width: 56px; height: 32px",
    accessibility: "focusable",
    nearbyText: "Copy",
    nearbyElements: "div.min-w-0",
    fullPath: "body.bb-app-shell > div#root > main > div.thread-message-list button",
    isMultiSelect: true,
    kind: "feedback",
    status: "pending",
    thread: [],
    sessionId: "ses_screenshot",
    bb: {
      route: `/projects/${STACK_PROJECT_ID}/threads/${STACK_THREAD_ID}`,
      pluginId: null,
      surface: null,
      threadId: STACK_THREAD_ID,
      projectId: STACK_PROJECT_ID,
      routeLabel: `thread ${STACK_THREAD_ID}`,
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
    const annotations =
      options.toolbarAnnotation && input.route === annotation.bb.route ? [annotation] : [];
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
    }),
  );
  await context.route("**/api/v1/plugins/agentation/rpc/listStagedAnnotations", (route) =>
    fulfillRpc(route, { annotations: options.stagedAnnotation ? [annotation] : [] }),
  );
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
      path:
        fixture.projectId === STACK_PROJECT_ID
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
      attachments:
        message.role === "user"
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
      turnRequest:
        message.role === "user" ? { isGrouped: false, kind: "message", status: "accepted" } : null,
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

async function mockThread(context: BrowserContext, fixture: ThreadCaptureFixture): Promise<void> {
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
    }),
  );
  await context.route(`**/api/v1/environments/${environmentId}/pull-request`, (route) =>
    fulfillJson(route, { outcome: "absent" }),
  );
  const base = `/api/v1/threads/${fixture.id}`;
  const responses = new Map<string, unknown>([
    [base, captureThreadMetadata(fixture)],
    [`${base}/timeline`, captureTimeline(fixture)],
    [
      `${base}/conversation-outline`,
      {
        items: fixture.messages.map((message, index) => ({
          id: `${fixture.id}:screenshot:${index + 1}`,
          role: message.role,
          preview: message.text.replaceAll(/\s+/g, " ").slice(0, 200),
          attachmentSummary: null,
        })),
        maxSeq: fixture.messages.length,
      },
    ],
    [
      `${base}/default-execution-options`,
      {
        model: "medium",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
        source: "client/turn/requested",
      },
    ],
    [`${base}/interactions`, []],
    [`${base}/prompt-history`, []],
    [`${base}/queued-messages`, []],
    [`${base}/tabs`, { revision: 1, tabs: fixture.tabs ?? [] }],
    [
      `${base}/thread-storage/files`,
      {
        files: [],
        truncated: false,
        storageRootPath: `/Users/example/.bb/thread-storage/${fixture.id}`,
      },
    ],
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
    settledSidebarThread("thr_capture_settled_3", "Fix account pool reset defaults", 16),
    settledSidebarThread("thr_capture_settled_4", "Update theme color palette", 41),
  ];
  await context.route("**/api/v1/sidebar-bootstrap", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sections: [], projects: [project], personalProject }),
    }),
  );
  await context.route("**/api/v1/threads", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(inbox),
    }),
  );
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
        rows: [
          ...inbox.slice(1).map((thread, index) => ({
            threadId: thread.id,
            settledAt: null,
            snoozedUntil: FIXED_TIME.valueOf() + 86_400_000,
            snoozedAt: FIXED_TIME.valueOf() - (index + 1) * 60_000,
          })),
          ...settledThreads.map((thread) => ({
            threadId: thread.id,
            settledAt: thread.settledAt,
            snoozedUntil: null,
            snoozedAt: null,
          })),
        ],
      });
    } else if (method === "listSettledThreads") {
      await fulfillRpc(route, { threads: settledThreads });
    } else await route.continue();
  });
}

async function createContext(
  browser: Browser,
  viewport: { width: number; height: number } = APP_VIEWPORT,
): Promise<BrowserContext> {
  const context = await createScreenshotContext(browser, {
    viewport,
    dpr: DPR,
  });
  await context.addInitScript(
    ({ order, orderKey }) => {
      localStorage.setItem(orderKey, JSON.stringify(order));
    },
    {
      order: SIDEBAR_PLUGIN_ORDER.map(({ id }) => id),
      orderKey: SIDEBAR_PLUGIN_ORDER_KEY,
    },
  );
  await context.route("**/api/v1/system/execution-options?**", (route) =>
    fulfillJson(route, EXECUTION_OPTIONS),
  );
  await context.route("**/api/v1/hosts", (route) => fulfillJson(route, [SCREENSHOT_HOST]));
  await context.route("**/api/v1/hosts/host_screenshot/provider-clis/status", (route) =>
    fulfillJson(route, PROVIDER_CLI_STATUS),
  );
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
  await page.getByRole("button", { name: "Hide repository groups" }).waitFor({
    state: "attached",
  });
  await settle(page, options);
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
  const expected = [SIDEBAR_BUILTIN_LEAD_LABEL, ...SIDEBAR_PLUGIN_ORDER.map(({ label }) => label)];
  await page.waitForFunction((orderedLabels) => {
    const rows = document.querySelectorAll(
      '[data-testid="plugin-nav-sidebar-items"] > .bb-sidebar-hover-actions-row',
    );
    const actual = [...rows].map((row) => row.textContent?.trim());
    return (
      actual.length === orderedLabels.length &&
      actual.every((label, index) => label === orderedLabels[index])
    );
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

type WriteCapture = (page: Page, spec: FixtureSpec, clip?: ScreenshotClip) => Promise<void>;

function fixtureWriter(batch: ScreenshotBatch, outputDir: string | null): WriteCapture {
  return (page, spec, clip) =>
    batch.capture(page, {
      id: spec.id,
      output: outputPath(spec, outputDir),
      expected: { width: spec.width * DPR, height: spec.height * DPR },
      clip,
    });
}

async function captureAgentation(browser: Browser, writeCapture: WriteCapture): Promise<void> {
  const captureContext = await createContext(browser);
  try {
    await mockAgentation(captureContext, { toolbarAnnotation: true });
    await mockThread(captureContext, THREAD_CAPTURE_FIXTURES.stack!);
    const page = await createScreenshotPage(captureContext, { fixedTime: FIXED_TIME });
    await navigate(
      page,
      `/projects/${STACK_PROJECT_ID}/threads/${STACK_THREAD_ID}`,
      page.getByText("Stack submitted", { exact: true }),
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
    await writeCapture(page, spec, centeredClip(shell, spec, APP_VIEWPORT.height - spec.height));
  } finally {
    await stagingContext.close();
  }
}

async function showRightPanel(page: Page): Promise<void> {
  const show = page.getByRole("button", { name: /Show right panel/ });
  if (await show.count()) await show.click();
  await page.locator("#thread-detail-secondary-panel").waitFor({ state: "visible" });
}

async function captureMonokai(browser: Browser, writeCapture: WriteCapture): Promise<void> {
  const appContext = await createContext(browser);
  try {
    await mockAgentation(appContext, {});
    await mockGtdSidebar(appContext);
    await mockThread(appContext, THREAD_CAPTURE_FIXTURES.stack!);
    const page = await createScreenshotPage(appContext, { fixedTime: FIXED_TIME });
    await navigate(
      page,
      `/projects/${STACK_PROJECT_ID}/threads/${STACK_THREAD_ID}`,
      page.getByText("Stack submitted", { exact: true }),
    );
    await showRightPanel(page);
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
    await navigate(page, "/", page.getByRole("button", { name: "Hide repository groups" }));
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
  agentation: captureAgentation,
  "gtd-sidebar": captureGtdSidebar,
  monokai: captureMonokai,
};

async function main(): Promise<void> {
  let options: ScreenshotOptions;
  try {
    options = parseScreenshotArguments(process.argv.slice(2));
  } catch (error) {
    console.error(
      `plugin-screenshot-fixtures: ${error instanceof Error ? error.message : String(error)}\n\n${usage()}`,
    );
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
  if (unknown.length > 0)
    throw new Error(`unknown plugin${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);

  await assertFixturePrerequisites(appUrl("/"), requested);

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
