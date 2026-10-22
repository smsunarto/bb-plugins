import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { instanceSchema, type Access, type Inspection, type Target } from "../schema.ts";
import { run, shellQuote, type Run } from "./process.ts";

const operationSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  status: z.string(),
  targetId: z.string().optional(),
  error: z
    .object({ errors: z.array(z.object({ code: z.string(), message: z.string().optional() })) })
    .optional(),
});

class CloudHttpError extends Error {
  constructor(
    readonly status: number,
    method: string,
  ) {
    super(
      `Google Compute ${method} failed (HTTP ${status}). Check permissions, VM state, and capacity.`,
    );
  }
}

export class GoogleCompute {
  constructor(
    private readonly execute: Run = run,
    private readonly request: typeof fetch = fetch,
    private readonly pause: (signal: AbortSignal, delayMs?: number) => Promise<unknown> = (
      signal,
      delayMs = 2000,
    ) => delay(delayMs, undefined, { signal }),
  ) {}

  private async token(access: Access, signal: AbortSignal) {
    const result = await this.execute(
      access.gcloudPath,
      [
        "auth",
        "print-access-token",
        "--quiet",
        ...(access.account ? [`--account=${access.account}`] : []),
      ],
      { signal, timeoutMs: 20_000 },
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error(
        "Google authentication failed on the controller. Sign in to gcloud there and retry.",
      );
    }
    return result.stdout.trim();
  }

  private zoneUrl(target: Target) {
    return `https://compute.googleapis.com/compute/v1/projects/${target.project}/zones/${target.zone}`;
  }

  private async api(url: string, token: string, signal: AbortSignal, method = "GET") {
    const response = await this.request(url, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      redirect: "error",
    });
    if (!response.ok) throw new CloudHttpError(response.status, method);
    return response.json() as Promise<unknown>;
  }

  private async read(target: Target, token: string, signal: AbortSignal): Promise<Inspection> {
    let data: unknown;
    try {
      data = await this.api(
        `${this.zoneUrl(target)}/instances/${target.instanceId}`,
        token,
        signal,
      );
    } catch (error) {
      if (error instanceof CloudHttpError && error.status === 404) {
        return {
          id: target.instanceId,
          name: target.instance,
          status: "NOT_FOUND",
          persistentDisksOnly: false,
        };
      }
      throw error;
    }
    const vm = instanceSchema.parse(data);
    if (vm.id !== target.instanceId || vm.name !== target.instance)
      throw new Error("GCP VM identity changed; refusing to control a replacement instance.");
    return {
      id: vm.id,
      name: vm.name,
      status: vm.status,
      persistentDisksOnly: vm.disks.every((disk) => disk.type === "PERSISTENT"),
    };
  }

  async inspect(target: Target, access: Access, signal: AbortSignal) {
    return this.read(target, await this.token(access, signal), signal);
  }

  async power(
    target: Target,
    access: Access,
    action: "start" | "stop",
    requestId: string,
    caller: AbortSignal,
  ) {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(8 * 60_000)]);
    const desired = action === "start" ? "RUNNING" : "TERMINATED";
    let prepared: { token: string; vm: Inspection };
    try {
      prepared = await this.preparePower(target, access, action, signal);
    } catch (error) {
      return {
        outcome: "not-submitted" as const,
        error: error instanceof Error ? error.message : "Cloud preflight failed.",
      };
    }
    const { token, vm } = prepared;
    if (vm.status === "NOT_FOUND") return { outcome: "gone" as const };
    if (vm.status === desired) return { outcome: "completed" as const, vm };
    let submitted: unknown;
    try {
      submitted = await this.api(
        `${this.zoneUrl(target)}/instances/${target.instanceId}/${action}?requestId=${requestId}`,
        token,
        signal,
        "POST",
      );
    } catch (error) {
      if (
        error instanceof CloudHttpError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      ) {
        return { outcome: "not-submitted" as const, error: error.message };
      }
      throw error;
    }
    const operation = await this.waitForOperation(target, token, signal, submitted);
    if (operation.error)
      return {
        outcome: "failed" as const,
        error: `Google ${action} failed: ${operation.error.errors.map((error) => error.code).join(", ")}`,
      };
    // A completed operation is followed by an authoritative VM read, not another write.
    const completed = await this.read(target, token, signal);
    if (completed.status !== desired)
      throw new Error(
        `Google completed ${action}, but the VM reports ${completed.status}. Retry to reconcile.`,
      );
    return { outcome: "completed" as const, vm: completed };
  }

  private async preparePower(
    target: Target,
    access: Access,
    action: "start" | "stop",
    signal: AbortSignal,
  ) {
    const token = await this.token(access, signal);
    const desired = action === "start" ? "RUNNING" : "TERMINATED";
    for (;;) {
      signal.throwIfAborted();
      const vm = await this.read(target, token, signal);
      if (vm.status === "NOT_FOUND") return { token, vm };
      if (!vm.persistentDisksOnly)
        throw new Error(
          "Only VMs with persistent disks are supported. Refusing to risk Local SSD data.",
        );
      if (vm.status === desired) return { token, vm };
      if (["STOPPING", "STAGING", "PROVISIONING", "REPAIRING"].includes(vm.status)) {
        await this.pause(signal);
        continue;
      }
      if (vm.status !== (action === "start" ? "TERMINATED" : "RUNNING")) {
        throw new Error(`Cannot ${action} a VM in ${vm.status} state.`);
      }
      return { token, vm };
    }
  }

  private async waitForOperation(
    target: Target,
    token: string,
    signal: AbortSignal,
    initial: unknown,
  ) {
    let operation = operationSchema.parse(initial);
    for (;;) {
      if (operation.targetId && operation.targetId !== target.instanceId)
        throw new Error("Google operation targets a different VM.");
      if (operation.status === "DONE") return operation;
      await this.pause(signal);
      operation = operationSchema.parse(
        await this.api(`${this.zoneUrl(target)}/operations/${operation.name}`, token, signal),
      );
    }
  }

  async bootstrap(
    target: Target,
    access: Access,
    command: string[],
    stdin: string,
    timeoutMs: number,
    signal: AbortSignal,
  ) {
    signal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const connectDeadline = Date.now() + 120_000;
    const commandArgs = [
      "compute",
      "ssh",
      `${access.sshUser}@${target.instance}`,
      `--project=${target.project}`,
      `--zone=${target.zone}`,
      "--tunnel-through-iap",
      "--quiet",
      "--strict-host-key-checking=yes",
      `--command=${command.map(shellQuote).join(" ")}`,
      ...(access.account ? [`--account=${access.account}`] : []),
      "--",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=20",
    ];
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const vm = await this.inspect(target, access, signal);
      if (vm.status !== "RUNNING")
        throw new Error("The pinned VM must be running before BB can start its daemon.");
      const result = await this.execute(access.gcloudPath, commandArgs, {
        signal,
        timeoutMs,
        stdin,
      });
      // Retry only failures before an SSH session exists, never a command failure
      // or a dropped session whose remote command may already have run.
      const connecting =
        result.stdout.length === 0 &&
        (/ssh: connect to host [^\r\n]+ port \d+: (?:Connection refused|Connection timed out|Operation timed out)/i.test(
          result.stderr,
        ) ||
          /^Connection timed out during banner exchange\r?$/m.test(result.stderr) ||
          /Error while connecting \[4003:[^\r\n]*failed to connect to backend/i.test(
            result.stderr,
          ));
      const output = {
        exitCode: result.exitCode,
        output: (result.stdout + result.stderr).slice(-16000),
      };
      if (result.exitCode === 0 || !connecting || attempt >= 11 || Date.now() >= connectDeadline)
        return output;
      await this.pause(signal, Math.min(2000 * 2 ** attempt, 15_000, connectDeadline - Date.now()));
      signal.throwIfAborted();
      if (Date.now() >= connectDeadline) return output;
    }
  }
}
