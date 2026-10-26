import { describe, expect, test } from "bun:test";
import { createServer, connect } from "node:net";
import { isLocalAddress, startPublicProxy } from "./public-proxy.ts";

/** Sends one SOCKS5 CONNECT for a domain name and returns the proxy's reply code. */
async function socksConnect(proxyPort: number, host: string, port: number): Promise<number> {
  const socket = connect(proxyPort, "127.0.0.1");
  const replies: Buffer[] = [];
  socket.on("data", (chunk) => replies.push(chunk));
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  const name = Buffer.from(host, "latin1");
  socket.write(Buffer.from([5, 1, 0]));
  socket.write(
    Buffer.concat([
      Buffer.from([5, 1, 0, 3, name.length]),
      name,
      Buffer.from([port >> 8, port & 0xff]),
    ]),
  );
  await new Promise<void>((resolve) => socket.once("close", resolve).once("end", resolve));
  return Buffer.concat(replies)[3]!;
}

describe("isLocalAddress", () => {
  test("blocks loopback, private, link-local, and CGNAT ranges", () => {
    for (const address of [
      "127.0.1.1",
      "0.0.0.0",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.100.100.100",
    ]) {
      expect(isLocalAddress(address, 4)).toBe(true);
    }
    expect(isLocalAddress("::1", 6)).toBe(true);
    expect(isLocalAddress("fe80::1", 6)).toBe(true);
    expect(isLocalAddress("::ffff:127.0.0.1", 6)).toBe(true);
  });

  test("checks IPv4 carried in NAT64 and 6to4 addresses", () => {
    expect(isLocalAddress("64:ff9b::7f00:1", 6)).toBe(true);
    expect(isLocalAddress("2002:c0a8:0101::1", 6)).toBe(true);
    expect(isLocalAddress("64:ff9b::808:808", 6)).toBe(false);
  });

  test("allows public addresses", () => {
    expect(isLocalAddress("8.8.8.8", 4)).toBe(false);
    expect(isLocalAddress("2606:4700:4700::1111", 6)).toBe(false);
  });
});

describe("startPublicProxy", () => {
  test("refuses names and literals that reach this machine", async () => {
    let hits = 0;
    const target = createServer((socket) => {
      hits += 1;
      socket.end();
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const { port } = target.address() as { port: number };
    const proxy = await startPublicProxy();
    try {
      // Reply code 2 is "connection not allowed by ruleset".
      expect(await socksConnect(proxy.port, "localhost", port)).toBe(2);
      expect(await socksConnect(proxy.port, "127.0.0.1", port)).toBe(2);
      expect(hits).toBe(0);
    } finally {
      await proxy.close();
      target.close();
    }
  });
});
