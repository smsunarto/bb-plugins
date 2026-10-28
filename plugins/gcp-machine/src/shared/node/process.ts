import { experimental_spawnHostProcess as spawn } from "@get-bb/plugin-sdk/process";

export type Run = (
  executable: string,
  args: string[],
  options: {
    signal: AbortSignal;
    timeoutMs: number;
    stdin?: string;
  },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const run: Run = (executable, args, options) =>
  new Promise((resolve, reject) => {
    options.signal.throwIfAborted();
    if (process.platform !== "darwin" && process.platform !== "linux") {
      reject(new Error("The GCP controller requires macOS or Linux."));
      return;
    }
    const child = spawn(executable, args, {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" },
    });
    let stdout = "",
      stderr = "",
      failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
    };
    const abort = () => stop(new Error("GCP command cancelled."));
    const timer = setTimeout(() => stop(new Error("GCP command timed out.")), options.timeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (stream === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > 2 * 1024 * 1024)
        stop(new Error("GCP command output exceeded its limit."));
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.stdin.on("error", () => {
      /* an early process exit is handled below */
    });
    child.once("error", () => {
      failure = new Error("Cannot start gcloud. Check its path on the controller machine.");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.end(options.stdin ?? "");
    if (options.signal.aborted) abort();
  });

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
