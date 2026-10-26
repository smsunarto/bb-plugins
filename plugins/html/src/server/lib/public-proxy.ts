import { lookup } from "node:dns/promises";
import { BlockList, connect, createServer, isIP } from "node:net";
import type { LookupFunction, Server, Socket } from "node:net";
import { networkInterfaces } from "node:os";

/**
 * A loopback SOCKS5 proxy that only connects to public addresses, so a
 * previewed page cannot reach the bb server's own machine or private
 * network. Ported from T3 Code's `publicProxy.ts`.
 */

const LOCAL_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
// Block IPv4-carrying IPv6 ranges that translators may route without checking.
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

const NAT64 = new BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");
const SIX_TO_FOUR = new BlockList();
SIX_TO_FOUR.addSubnet("2002::", 16, "ipv6");

const ipv6Groups = (address: string) => {
  const bare = address.split("%", 1)[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  const text = dotted
    ? `${bare.slice(0, dotted.index)}${((+dotted[1]! << 8) | +dotted[2]!).toString(16)}:${((+dotted[3]! << 8) | +dotted[4]!).toString(16)}`
    : bare;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(fill).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
};

// Check the translated IPv4 too, while allowing public NAT64 targets on IPv6-only networks.
const embeddedIPv4 = (address: string) => {
  const at = NAT64.check(address, "ipv6") ? 6 : SIX_TO_FOUR.check(address, "ipv6") ? 1 : -1;
  if (at === -1) return undefined;
  const groups = ipv6Groups(address);
  const high = groups[at] ?? 0;
  const low = groups[at + 1] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

const ownAddresses = () => {
  const own = new BlockList();
  for (const entry of Object.values(networkInterfaces()).flat()) {
    if (entry) own.addAddress(entry.address, entry.family === "IPv6" ? "ipv6" : "ipv4");
  }
  return own;
};

export function isLocalAddress(address: string, family: number): boolean {
  const type = family === 6 ? "ipv6" : "ipv4";
  if (LOCAL_ADDRESSES.check(address, type) || ownAddresses().check(address, type)) return true;
  const embedded = family === 6 ? embeddedIPv4(address) : undefined;
  return embedded !== undefined && isLocalAddress(embedded, 4);
}

type Address = { address: string; family: number };

// Connect only to checked addresses to prevent DNS rebinding.
async function publicAddresses(host: string): Promise<Address[] | undefined> {
  const addresses: Address[] = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0) return undefined;
  return addresses.some(({ address, family }) => isLocalAddress(address, family))
    ? undefined
    : addresses;
}

// SOCKS5 (RFC 1928) replies: success, refused by rule, host unreachable, command unsupported.
const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

const MAX_EARLY_BYTES = 64 * 1024;

const refuse = (client: Socket, code: number) => {
  client.end(reply(code), () => client.destroy());
};

function readRequest(data: Buffer) {
  if (data.length < 5) return "short" as const;
  if (data[0] !== 5 || data[2] !== 0) return undefined;
  const type = data[3];
  const end = type === 1 ? 10 : type === 3 ? 7 + data[4]! : type === 4 ? 22 : -1;
  if (end === -1) return undefined;
  if (data.length < end) return "short" as const;
  const host =
    type === 1
      ? [...data.subarray(4, 8)].join(".")
      : type === 3
        ? data.subarray(5, 5 + data[4]!).toString("latin1")
        : Array.from({ length: 8 }, (_, index) =>
            data.readUInt16BE(4 + index * 2).toString(16),
          ).join(":");
  return { command: data[1], host, port: data.readUInt16BE(end - 2), rest: data.subarray(end) };
}

async function relay(
  track: (socket: Socket) => Socket,
  client: Socket,
  host: string,
  port: number,
  early: Buffer[],
  holdEarly: (chunk: Buffer) => void,
) {
  const addresses = await publicAddresses(host);
  if (client.destroyed) return;
  client.off("data", holdEarly);
  if (addresses === undefined) {
    refuse(client, 2);
    return;
  }
  client.pause();
  // Try all checked addresses so broken IPv6 routes do not block IPv4 access.
  const lookupChecked: LookupFunction = (_host, options, callback) => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };
  const upstream = track(connect({ host, port, autoSelectFamily: true, lookup: lookupChecked }));
  upstream.once("connect", () => {
    client.write(reply(0));
    for (const chunk of early) upstream.write(chunk);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("close", () => client.destroy());
  client.on("close", () => upstream.destroy());
}

export interface PublicProxy {
  readonly port: number;
  close(): Promise<void>;
}

/** Covers requests Chrome's Local Network Access misses, including speculation prefetches. */
export function startPublicProxy(): Promise<PublicProxy> {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const server: Server = createServer((client) => {
    track(client);
    let data = Buffer.alloc(0);
    let greeted = false;
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (!greeted) {
        if (data.length < 2 || data.length < 2 + data[1]!) return;
        if (data[0] !== 5 || !data.subarray(2, 2 + data[1]!).includes(0)) {
          client.end(Buffer.from([5, 0xff]));
          return;
        }
        data = data.subarray(2 + data[1]!);
        greeted = true;
        client.write(Buffer.from([5, 0]));
      }
      const request = readRequest(data);
      if (request === "short") return;
      client.off("data", onData);
      if (request === undefined || request.command !== 1 || request.port === 0) {
        refuse(client, 7);
        return;
      }
      const early: Buffer[] = [request.rest];
      let earlyBytes = request.rest.length;
      const holdEarly = (chunk: Buffer) => {
        earlyBytes += chunk.length;
        if (earlyBytes > MAX_EARLY_BYTES) {
          client.destroy();
          return;
        }
        early.push(chunk);
      };
      client.on("data", holdEarly);
      void relay(track, client, request.host, request.port, early, holdEarly);
    };
    client.on("data", onData);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : 0,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
