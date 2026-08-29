import type * as MonacoNs from "monaco-editor";

const ASSET_LEASE_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const RENEWAL_RETRY_MS = 30 * 1000;
const USUAL_WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";
const MAX_OCCURRENCE_MATCHES = 1000;

export interface MonacoAssetLease {
  readonly baseUrl: string;
  readonly expiresAtMs: number;
}

export interface MonacoAcquisition {
  readonly monaco: typeof MonacoNs;
  release(): void;
}

type AssetLoader = () => Promise<MonacoAssetLease>;
type TimerHandle = unknown;

export interface MonacoRuntimeDependencies {
  readonly now: () => number;
  readonly loadModule: (url: string) => Promise<{ monaco?: typeof MonacoNs }>;
  readonly injectStylesheet: (url: string) => Promise<void>;
  readonly createWorker: (url: string) => Worker;
  readonly schedule: (callback: () => Promise<void>, delayMs: number) => TimerHandle;
  readonly cancel: (handle: TimerHandle) => void;
}

function assetUrl(baseUrl: string, name: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${name}`;
}

function defaultDependencies(): MonacoRuntimeDependencies {
  return {
    now: Date.now,
    loadModule: (url) => import(/* @vite-ignore */ url),
    injectStylesheet: (url) =>
      new Promise((resolve, reject) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = url;
        link.addEventListener("load", () => resolve(), { once: true });
        link.addEventListener(
          "error",
          () => {
            link.remove();
            reject(new Error(`Failed to load ${url}`));
          },
          { once: true },
        );
        document.head.appendChild(link);
      }),
    createWorker: (url) => new Worker(url, { type: "module" }),
    schedule: (callback, delayMs) => setTimeout(() => void callback(), delayMs),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function registerOccurrenceHighlighting(monaco: typeof MonacoNs): void {
  const languageIds = monaco.languages.getLanguages().map((entry) => entry.id);
  monaco.languages.registerDocumentHighlightProvider(languageIds, {
    provideDocumentHighlights(model, position) {
      const word = model.getWordAtPosition(position);
      if (word === null) return [];
      return model
        .findMatches(
          word.word,
          false,
          false,
          true,
          USUAL_WORD_SEPARATORS,
          false,
          MAX_OCCURRENCE_MATCHES,
        )
        .map((match) => ({
          range: match.range,
          kind: monaco.languages.DocumentHighlightKind.Text,
        }));
    },
  });
}

export function createMonacoRuntime(
  dependencies: MonacoRuntimeDependencies = defaultDependencies(),
) {
  let lease: MonacoAssetLease | null = null;
  let leasePromise: Promise<MonacoAssetLease> | null = null;
  let stylesheetPromise: Promise<void> | null = null;
  let bootPromise: Promise<typeof MonacoNs> | null = null;
  let monaco: typeof MonacoNs | null = null;
  let workerBaseUrl = "";
  let acquisitions = 0;
  let renewalLoader: AssetLoader | null = null;
  let renewalTimer: TimerHandle | null = null;

  function installWorkerFactory(): void {
    (globalThis as { MonacoEnvironment?: { getWorker: () => Worker } }).MonacoEnvironment = {
      getWorker: () => dependencies.createWorker(assetUrl(workerBaseUrl, "editor.worker.js")),
    };
  }

  async function ensureLease(loadAssets: AssetLoader, force = false): Promise<MonacoAssetLease> {
    if (
      !force &&
      lease !== null &&
      lease.expiresAtMs - dependencies.now() > ASSET_LEASE_REFRESH_MARGIN_MS
    ) {
      return lease;
    }
    leasePromise ??= loadAssets()
      .then((next) => {
        lease = next;
        workerBaseUrl = next.baseUrl;
        installWorkerFactory();
        return next;
      })
      .finally(() => {
        leasePromise = null;
      });
    return leasePromise;
  }

  async function boot(assets: MonacoAssetLease): Promise<typeof MonacoNs> {
    stylesheetPromise ??= dependencies
      .injectStylesheet(assetUrl(assets.baseUrl, "editor.css"))
      .catch((error: unknown) => {
        stylesheetPromise = null;
        throw error;
      });
    await stylesheetPromise;
    const loaded = await dependencies.loadModule(assetUrl(assets.baseUrl, "editor.js"));
    if (loaded.monaco === undefined) {
      throw new Error("the Monaco bundle did not expose its API");
    }
    registerOccurrenceHighlighting(loaded.monaco);
    return loaded.monaco;
  }

  async function ensureBoot(assets: MonacoAssetLease): Promise<typeof MonacoNs> {
    if (monaco !== null) return monaco;
    bootPromise ??= boot(assets)
      .then((loaded) => {
        monaco = loaded;
        return loaded;
      })
      .finally(() => {
        bootPromise = null;
      });
    return bootPromise;
  }

  function clearRenewal(): void {
    if (renewalTimer === null) return;
    dependencies.cancel(renewalTimer);
    renewalTimer = null;
  }

  function scheduleRenewal(reset = false, retryDelayMs?: number): void {
    if (reset) clearRenewal();
    if (renewalTimer !== null || acquisitions === 0 || lease === null || renewalLoader === null) {
      return;
    }
    const delay =
      retryDelayMs ??
      Math.max(0, lease.expiresAtMs - dependencies.now() - ASSET_LEASE_REFRESH_MARGIN_MS);
    renewalTimer = dependencies.schedule(async () => {
      renewalTimer = null;
      if (acquisitions === 0 || renewalLoader === null) return;
      try {
        await ensureLease(renewalLoader, true);
        scheduleRenewal();
      } catch {
        scheduleRenewal(false, RENEWAL_RETRY_MS);
      }
    }, delay);
  }

  return {
    async acquire(loadAssets: AssetLoader): Promise<MonacoAcquisition> {
      renewalLoader = loadAssets;
      const assets = await ensureLease(loadAssets);
      const loaded = await ensureBoot(assets);
      acquisitions += 1;
      scheduleRenewal(true);
      let released = false;
      return {
        monaco: loaded,
        release() {
          if (released) return;
          released = true;
          acquisitions -= 1;
          if (acquisitions === 0) clearRenewal();
        },
      };
    },
  };
}

export const monacoRuntime = createMonacoRuntime();
