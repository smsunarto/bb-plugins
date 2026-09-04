import { spawn } from "node:child_process";

export type Capture = { stdout: string; stderr: string; code: number; timedOut: boolean };

export type SpawnOptions = {
  cwd?: string;
  timeoutMs?: number;
  stdin?: "ignore" | "inherit";
};

export function capture(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<Capture> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const alarm =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (alarm !== null) clearTimeout(alarm);
      reject(error);
    });
    child.on("close", (code) => {
      if (alarm !== null) clearTimeout(alarm);
      resolve({ stdout, stderr, code: code ?? -1, timedOut });
    });
  });
}

export async function run(command: string, args: string[], cwd: string): Promise<string> {
  const result = await capture(command, args, { cwd });
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}
