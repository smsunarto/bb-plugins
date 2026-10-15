import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { generationJob, normalizeMediaRequest, type GenerationJob } from "../shared/generation.ts";
import { cliProviders, ProviderFailure, runCommand, type RunCommand } from "./providers.ts";
import { cloudProviders, type Credentials } from "./cloud-providers.ts";

type Start = {
  rootPath: string;
  jobId: string;
  threadId: string | null;
  origin?: GenerationJob["origin"];
  request: GenerationJob["request"];
  target?: GenerationJob["target"];
  credentials?: Credentials;
};
type Target = { rootPath: string; jobId: string };
type Work = { controller: AbortController; done: Promise<void> };

/** All disk writes stay in canvas. A submitted identity is never retried as a new submission. */
export class GenerationRunner {
  private readonly active = new Map<string, Work>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly run: RunCommand;
  constructor(run: RunCommand = runCommand) {
    this.run = run;
  }

  private async locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }
  private key(target: Target) {
    return `${target.rootPath}\0${target.jobId}`;
  }
  private async root(path: string) {
    if (!isAbsolute(path)) throw new Error("The project path must be absolute.");
    return realpath(path);
  }
  private async directory(root: string, parts: string[]) {
    let current = root;
    for (const part of parts) {
      current = join(current, part);
      try {
        await mkdir(current);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory())
        throw new Error("Canvas output directories cannot be symbolic links.");
    }
    return current;
  }
  private async file(root: string, path: string) {
    const resolved = await realpath(join(root, path));
    const rel = relative(root, resolved);
    if (
      rel.startsWith(`..${sep}`) ||
      rel === ".." ||
      isAbsolute(rel) ||
      !(await stat(resolved)).isFile()
    )
      throw new Error("A generation reference must be a file inside the project.");
    return resolved;
  }
  private path(target: Target) {
    return join(target.rootPath, "canvas", "jobs", `${target.jobId}.json`);
  }
  private async read(target: Target) {
    const jobId = generationJob.shape.id.parse(target.jobId);
    const path = join(await this.fileDirectory(target.rootPath, "canvas/jobs"), `${jobId}.json`);
    if (!(await lstat(path)).isFile())
      throw new Error("Generation job records must be regular files, without symbolic links.");
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      if (!(await handle.stat()).isFile())
        throw new Error("A generation job record must be a file inside the project.");
      // Atomic saves replace the pathname; keep reading the same opened receipt.
      return generationJob.parse(JSON.parse(await handle.readFile("utf8")));
    } finally {
      await handle.close();
    }
  }
  private async save(target: Target, job: GenerationJob) {
    job.updatedAt = Date.now();
    const temporary = `${this.path(target)}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, this.path(target));
  }
  async start(input: Start): Promise<{ created: boolean; job: GenerationJob }> {
    const rootPath = await this.root(input.rootPath),
      target = { rootPath, jobId: input.jobId };
    const request = normalizeMediaRequest(input.request);
    return this.locked(this.key(target), async () => {
      await this.directory(rootPath, ["canvas", "jobs"]);
      try {
        await lstat(`${this.path(target)}.cancelled`);
        throw new Error(
          "This request ID was retired without a submission. Choose a new request ID.",
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const job: GenerationJob = {
        version: 1,
        id: input.jobId,
        threadId: input.threadId,
        origin: input.origin ?? { kind: "agent" },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: "queued",
        request,
        outputs: [],
        ...(input.target ? { target: input.target } : {}),
      };
      const temporary = `${this.path(target)}.${randomUUID()}.tmp`;
      try {
        // Publish only a complete, flushed record. A crash before linking leaves an ignored temp file.
        const handle = await open(temporary, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(job, null, 2)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await link(temporary, this.path(target));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        const existing = await this.read(target);
        if (
          !isDeepStrictEqual(existing.request, request) ||
          !isDeepStrictEqual(existing.target, job.target) ||
          existing.threadId !== input.threadId ||
          !isDeepStrictEqual(existing.origin, job.origin)
        )
          throw new Error(
            "This request ID already belongs to a different generation. Use its status or choose a new request ID.",
            { cause: error },
          );
        return { created: false, job: existing };
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      // BB text runs are executed by the server, but use the same durable reservation fence.
      if (job.request.kind !== "text") this.launch(target, job, false, input.credentials ?? {});
      return { created: true, job: structuredClone(job) };
    });
  }
  private launch(target: Target, job: GenerationJob, resume: boolean, credentials: Credentials) {
    const controller = new AbortController();
    const done = this.execute(target, job, resume, controller.signal, credentials).finally(() =>
      this.active.delete(this.key(target)),
    );
    this.active.set(this.key(target), { controller, done });
    void done.catch(() => undefined);
  }
  private async execute(
    target: Target,
    job: GenerationJob,
    resume: boolean,
    signal: AbortSignal,
    credentials: Credentials,
  ) {
    let submitting = false;
    try {
      const outputPath = await this.directory(target.rootPath, ["canvas", "staging", job.id]);
      const request = job.request;
      const paths =
        request.kind === "image" || request.kind === "text"
          ? request.images
          : request.kind === "video"
            ? [
                ...(request.imagePath ? [request.imagePath] : []),
                ...(request.endImagePath ? [request.endImagePath] : []),
              ]
            : [request.approvedImagePath];
      const imagePaths = await Promise.all(paths.map((path) => this.file(target.rootPath, path)));
      for (const path of imagePaths) {
        if (!/\.(png|jpe?g|webp)$/i.test(path))
          throw new Error("Generation references must be PNG, JPEG, or WebP images.");
      }
      const provider = { ...cliProviders, ...cloudProviders(credentials) }[request.model.provider];
      if (!provider) throw new Error("No generation adapter is installed for this provider.");
      const context = {
        request,
        rootPath: target.rootPath,
        outputPath,
        imagePaths,
        signal,
        run: this.run,
        get providerData() {
          return job.providerData;
        },
        recordTask: async (id: string, data?: Record<string, string>) => {
          job.taskId = id;
          if (data) job.providerData = data;
          await this.save(target, job);
        },
      };
      job.status = "running";
      delete job.detail;
      await this.save(target, job);
      if (!resume) {
        submitting = true;
        job.taskId = await provider.submit(context);
        await this.save(target, job);
      }
      if (!job.taskId)
        throw new Error("A provider task identity is required to resume generation.");
      await provider.collect(context, job.taskId);
      signal.throwIfAborted();
      job.outputs = await this.outputs(target, job);
      const expected = request.outputCount ?? 1;
      if (job.outputs.length !== expected)
        throw new ProviderFailure(
          `Expected ${expected} outputs but found ${job.outputs.length}. Resume the saved task to recover downloads.`,
          "uncertain",
          job.taskId,
        );
      job.status = "succeeded";
    } catch (error) {
      if (signal.aborted) job.status = submitting || job.taskId ? "uncertain" : "cancelled";
      else if (error instanceof ProviderFailure) job.status = error.status;
      else job.status = submitting || job.taskId ? "uncertain" : "failed";
      job.detail = signal.aborted
        ? "Stopped waiting locally. A provider submission may still be running; it was not resubmitted."
        : error instanceof Error
          ? error.message.slice(0, 2000)
          : "Generation failed.";
    }
    await this.save(target, job);
  }
  private async outputs(target: Target, job: GenerationJob) {
    const root = await this.directory(target.rootPath, ["canvas", "staging", job.id]);
    const matches: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4) throw new Error("Generation output exceeded the directory depth limit.");
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
          throw new Error("Generation output cannot contain symbolic links.");
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (
          (job.request.kind === "image"
            ? /\.(png|jpe?g|webp)$/i
            : job.request.kind === "text"
              ? /\.md$/i
              : job.request.kind === "video"
                ? /\.(mp4|webm)$/i
                : /\.glb$/i
          ).test(entry.name)
        )
          matches.push(path);
        if (matches.length > 20) throw new Error("Generation produced too many output files.");
      }
    };
    await walk(root, 0);
    return Promise.all(
      matches.sort().map(async (file) => {
        const sizeBytes = (await stat(file)).size;
        if (sizeBytes === 0 || sizeBytes > 512 * 1024 * 1024)
          throw new Error("Generated output is empty or exceeds 512 MiB.");
        const handle = await open(file, "r");
        const hash = createHash("sha256");
        try {
          for await (const chunk of handle.createReadStream()) hash.update(chunk);
        } finally {
          await handle.close();
        }
        return {
          path: relative(target.rootPath, file).split(sep).join("/"),
          type: job.request.kind === "model-3d" ? ("model" as const) : job.request.kind,
          sizeBytes,
          sha256: hash.digest("hex"),
        };
      }),
    );
  }
  async reconcileMissing(input: Target) {
    const target = { ...input, rootPath: await this.root(input.rootPath) };
    return this.locked(this.key(target), async () => {
      await this.directory(target.rootPath, ["canvas", "jobs"]);
      try {
        await this.read(target);
        return { missing: false };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      // This fence wins the same lock as start, preventing a delayed dispatch from submitting later.
      try {
        await writeFile(
          `${this.path(target)}.cancelled`,
          "Request retired before a confirmed submission.\n",
          { flag: "wx" },
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      return { missing: true };
    });
  }
  async status(input: Target): Promise<GenerationJob> {
    const target = { ...input, rootPath: await this.root(input.rootPath) };
    return this.locked(this.key(target), async () => {
      const active = this.active.has(this.key(target));
      const job = await this.read(target);
      if (job.request.kind === "text") return job;
      if ((job.status === "queued" || job.status === "running") && !active) {
        job.status = "uncertain";
        job.detail =
          "Generation was interrupted. Resume the saved task; a new submission will not be made.";
        await this.save(target, job);
      }
      return job;
    });
  }
  async list(rootPath: string): Promise<GenerationJob[]> {
    const root = await this.root(rootPath);
    let entries;
    try {
      entries = await readdir(await this.fileDirectory(root, "canvas/jobs"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const ids = entries.filter((name) => /^[a-zA-Z0-9_-]{1,100}\.json$/.test(name));
    if (ids.length > 1000) throw new Error("The project has more than 1000 generation jobs.");
    const results = await Promise.allSettled(
      ids.map((name) => this.status({ rootPath: root, jobId: name.slice(0, -5) })),
    );
    const jobs = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    return jobs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
  }
  private async fileDirectory(root: string, path: string) {
    const resolved = await realpath(join(root, path));
    if (!resolved.startsWith(`${root}${sep}`))
      throw new Error("Canvas jobs must stay inside the project.");
    return resolved;
  }
  async cancel(input: Target) {
    const target = { ...input, rootPath: await this.root(input.rootPath) };
    const active = this.active.get(this.key(target));
    if (active) {
      active.controller.abort();
      await active.done;
    }
    return this.locked(this.key(target), async () => {
      const job = await this.read(target);
      if (!["succeeded", "failed", "auth-required"].includes(job.status)) {
        job.status =
          job.taskId || ["running", "uncertain"].includes(job.status) ? "uncertain" : "cancelled";
        job.detail = "Stopped waiting locally. This does not cancel a submitted provider task.";
        await this.save(target, job);
      }
      return job;
    });
  }
  async resume(input: Target & { credentials?: Credentials }) {
    const target = { ...input, rootPath: await this.root(input.rootPath) };
    return this.locked(this.key(target), async () => {
      const job = await this.read(target);
      if (this.active.has(this.key(target)) || job.status === "succeeded") return job;
      if (!job.taskId)
        throw new Error(
          "There is no confirmed provider task to resume. Reconcile the provider receipt before making a new request.",
        );
      job.status = "queued";
      await this.save(target, job);
      this.launch(target, job, true, input.credentials ?? {});
      return job;
    });
  }
  async dispose() {
    for (const work of this.active.values()) work.controller.abort();
    await Promise.allSettled([...this.active.values()].map((work) => work.done));
  }
}
