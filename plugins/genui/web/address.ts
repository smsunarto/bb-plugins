// Which IP addresses the plugin may connect to. A URL in a spec is model
// output, so fetching it must never reach this machine, its network or any
// address that isn't on the public internet.
import { BlockList, isIP } from "node:net";

/** IPv4 ranges that are not public unicast (RFC 6890 and friends). */
const PRIVATE_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata lives here)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

/**
 * IPv6 is allowed only inside global unicast (2000::/3), which already
 * excludes loopback, unspecified, IPv4-mapped, NAT64, unique-local,
 * link-local and multicast; these special blocks inside it are refused too.
 */
const SPECIAL_V6: readonly (readonly [string, number])[] = [
  ["2001::", 23], // IETF protocol assignments (Teredo, benchmarking, ORCHID)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: tunnels to an embedded IPv4 address
  ["3fff::", 20], // documentation
];

const privateV4 = new BlockList();
for (const [network, prefix] of PRIVATE_V4) privateV4.addSubnet(network, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const specialV6 = new BlockList();
for (const [network, prefix] of SPECIAL_V6) specialV6.addSubnet(network, prefix, "ipv6");

/** True only for a literal IP address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  // A zone index (fe80::1%en0) only exists on link-local addresses.
  if (bare.includes("%")) return false;
  switch (isIP(bare)) {
    case 4:
      return !privateV4.check(bare, "ipv4");
    case 6:
      return globalV6.check(bare, "ipv6") && !specialV6.check(bare, "ipv6");
    default:
      return false;
  }
}
