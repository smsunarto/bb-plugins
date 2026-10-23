import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CanvasHost, readJobFiles, type CanvasDisk, type CanvasJobs } from "../src/host/canvas.ts";
import { canvasHostContract } from "../src/shared/canvas-contract.ts";
import { pathTools, projectFile } from "../src/shared/node/paths.ts";

/*
 * Server tests run the real canvas host in-process. A test whose files live
 * in a fake `bb.sdk.files` reads them through `sdkDisk`; one with a real
 * temporary directory uses the host's own `nodeDisk`.
 */

function missing(error: unknown): boolean {
  return (
    error instanceof Error &&
    /ENOENT|no such file or directory|Path does not exist/i.test(error.message)
  );
}

/** A CanvasDisk over BB's file API, as a test's fake implements it. */
export function sdkDisk(files: BbPluginApi["sdk"]["files"], hostId: string): CanvasDisk {
  return {
    async read(root, path) {
      try {
        const file = await files.read({ hostId, rootPath: root, path: projectFile(root, path) });
        return {
          content: file.content,
          contentEncoding: file.contentEncoding,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
        };
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async list(root, folder, limit) {
      const directory = projectFile(root, folder);
      let listing;
      try {
        listing = await files.list({ hostId, path: directory, limit });
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
      const paths = pathTools(root);
      return {
        files: listing.files.map(({ path }) =>
          paths.isAbsolute(path)
            ? paths.relative(directory, path).replaceAll("\\", "/")
            : path.startsWith(`${folder}/`)
              ? path.slice(folder.length + 1)
              : path,
        ),
        truncated: listing.truncated,
      };
    },
    async write(root, path, content, contentEncoding, expectedSha256) {
      const result = await files.write({
        hostId,
        rootPath: root,
        path: projectFile(root, path),
        content,
        contentEncoding,
        expectedSha256,
        createParents: true,
      });
      return result.outcome === "written" ? result.sha256 : null;
    },
    async copy(_fromRoot, _from, root, to, file) {
      return (await this.write(root, to, file.content, file.contentEncoding, null)) !== null;
    },
    async directory() {
      return false;
    },
  };
}

const unwatched = {
  experimental_watch: async () => ({ dispose: async () => undefined }),
  experimental_emitSignal: async () => undefined,
};

/**
 * Answers the canvas host methods the way a host daemon would, validating
 * input and output against the contract. Other methods return `undefined`.
 */
export function canvasHostRouter(
  disk: (hostId: string) => CanvasDisk,
  jobs?: CanvasJobs,
  options?: ConstructorParameters<typeof CanvasHost>[2],
) {
  const hosts = new Map<string, CanvasHost>();
  const hostFor = (hostId: string) => {
    let host = hosts.get(hostId);
    if (!host) {
      const files = disk(hostId);
      host = new CanvasHost(
        files,
        jobs ??
          (async (root) => ({
            workspacePath: root,
            jobs: await readJobFiles(files, root),
            stale: false,
          })),
        options,
      );
      hosts.set(hostId, host);
    }
    return host;
  };
  return {
    handles: (method: string): method is keyof typeof canvasHostContract =>
      method in canvasHostContract,
    async call(method: keyof typeof canvasHostContract, input: unknown, hostId: string) {
      const host = hostFor(hostId);
      const contract = canvasHostContract[method];
      const parsed = contract.input.parse(input);
      const output =
        method === "readCanvas"
          ? await host.read(parsed as never, unwatched)
          : method === "saveCanvasBoard"
            ? await host.saveBoard(parsed as never)
            : method === "mediaDir"
              ? // A fake host keeps its media in the checkout, as one not yet moved does.
                { dir: pathTools(parsed.rootPath).join(parsed.rootPath, "canvas") }
              : method === "captureCanvasInputs"
                ? await host.captureInputs(parsed as never)
                : (() => {
                    throw new Error(`Unexpected canvas host call: ${method}`);
                  })();
      return contract.output.parse(JSON.parse(JSON.stringify(output)));
    },
  };
}

/** A `bb.hosts` whose client runs the canvas host methods in-process over the fake's files. */
export function fakeCanvasHosts(bb: () => BbPluginApi): BbPluginApi["hosts"] {
  const router = canvasHostRouter((hostId) => sdkDisk(bb().sdk.files, hostId));
  return {
    experimental_client: () => ({
      call: (method: string, input: unknown, options: { hostId: string }) => {
        if (!router.handles(method)) throw new Error(`Unexpected host call: ${method}`);
        return router.call(method, input, options.hostId);
      },
      experimental_onSignal: () => () => undefined,
      experimental_onWorkerExit: () => () => undefined,
    }),
  } as unknown as BbPluginApi["hosts"];
}
