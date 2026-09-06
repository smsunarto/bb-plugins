import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk/host";

// The supervisor owns the child even if BB terminates the host worker without disposal.
export const supervisorSource = String.raw`
const {spawn}=require('node:child_process');
const child=spawn(process.argv[1],['tunnel','--no-autoupdate','run'],{env:process.env,stdio:['ignore','ignore','pipe']});
let stopping=false,tail='',killTimer;
function stop(){if(stopping)return;stopping=true;child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),3000);}
process.on('disconnect',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);
child.once('error',()=>{stopping=true;clearTimeout(killTimer);if(process.connected){process.send({event:'failed'});process.disconnect();}process.exitCode=1;});
child.once('spawn',()=>{if(process.connected)process.send({event:'spawned'});else stop();});
child.stderr.on('data',chunk=>{tail=(tail+chunk.toString()).slice(-8192);const match=tail.match(/Generated Connector ID[:= ]+([0-9a-f-]{36})/i);if(match&&process.connected){process.send({event:'connector',id:match[1]});tail='';}});
child.once('exit',()=>{stopping=true;clearTimeout(killTimer);if(process.connected)process.disconnect();});
`;
type Entry = {
  process: ChildProcess;
  done: Promise<void>;
  connectorId?: string;
  generation: string;
};
export class ConnectorManager {
  private entries = new Map<string, Entry>();
  private queue: Promise<unknown> = Promise.resolve();
  private serialize<T>(action: () => Promise<T>) {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  status(id: string) {
    const entry = this.entries.get(id);
    return {
      running: Boolean(
        entry && entry.process.exitCode === null && entry.process.signalCode === null,
      ),
      ...(entry?.connectorId ? { connectorId: entry.connectorId } : {}),
    };
  }
  start(id: string, token: string, executable: string, retain: () => ExperimentalHostWorkerLease) {
    return this.serialize(async () => {
      if (this.status(id).running) return this.status(id);
      const lease = retain();
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, ["-e", supervisorSource, executable], {
          env: { ...process.env, TUNNEL_TOKEN: token },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
      } catch {
        await lease.dispose();
        throw new Error("Unable to launch cloudflared on this host.");
      }
      const generation = randomUUID();
      let finished = false;
      const done = new Promise<void>((resolve) => {
        const finish = () => {
          if (finished) return;
          finished = true;
          if (this.entries.get(id)?.generation === generation) this.entries.delete(id);
          void lease.dispose().finally(resolve);
        };
        child.once("exit", finish);
        child.once("error", finish);
      });
      const entry: Entry = { process: child, done, generation };
      this.entries.set(id, entry);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("cloudflared did not start in time.")),
            8000,
          );
          const settle = (error?: Error) => {
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          };
          child.on("message", (message) => {
            if (!message || typeof message !== "object" || !("event" in message)) return;
            if (
              message.event === "connector" &&
              "id" in message &&
              typeof message.id === "string" &&
              /^[0-9a-f-]{36}$/i.test(message.id)
            )
              entry.connectorId = message.id;
            if (message.event === "spawned") settle();
            if (message.event === "failed")
              settle(
                new Error(
                  "cloudflared could not be launched. Check the executable setting on this host.",
                ),
              );
          });
          child.once("error", () => settle(new Error("Unable to start the connector supervisor.")));
          child.once("exit", () =>
            settle(new Error("cloudflared exited before becoming available.")),
          );
        });
      } catch (error) {
        await this.stopEntry(entry);
        throw error;
      }
      return this.status(id);
    });
  }
  private async stopEntry(entry: Entry) {
    if (entry.process.exitCode !== null || entry.process.signalCode !== null) {
      await entry.done;
      return;
    }
    if (entry.process.connected) entry.process.disconnect();
    else entry.process.kill("SIGTERM");
    await entry.done;
  }
  stop(id: string) {
    return this.serialize(async () => {
      const entry = this.entries.get(id);
      if (entry) await this.stopEntry(entry);
      return { running: false };
    });
  }
  dispose() {
    return this.serialize(async () => {
      await Promise.all([...this.entries.values()].map((entry) => this.stopEntry(entry)));
    });
  }
}
export async function probe(port: number, executable: string) {
  const available = await new Promise<boolean>((resolve) =>
    execFile(executable, ["--version"], { timeout: 3000, maxBuffer: 4096 }, (error) =>
      resolve(!error),
    ),
  );
  if (!available)
    return {
      available: false,
      originReachable: false,
      message:
        "Install cloudflared on the selected host or set its executable path in plugin settings.",
    };
  try {
    await fetch(`http://127.0.0.1:${port}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    return {
      available: true,
      originReachable: true,
      message: "cloudflared and the localhost origin are available.",
    };
  } catch {
    return {
      available: true,
      originReachable: false,
      message: `No HTTP origin responded at 127.0.0.1:${port} on the selected host.`,
    };
  }
}
