import { expect, test } from "bun:test";
import type { Overview } from "../shared/schema.ts";
import {
  activeTab,
  connectionLabel,
  dnsTypes,
  filterDnsRecords,
  identityProviderLabel,
  shareTone,
  tunnelTone,
} from "./labels.ts";

type DnsRecord = Overview["dnsRecords"]["items"][number];
const record = (overrides: Partial<DnsRecord>): DnsRecord => ({
  id: "r1",
  zoneId: "z1",
  zoneName: "example.com",
  name: "example.com",
  type: "A",
  content: "192.0.2.1",
  ...overrides,
});

test("identity providers without a display name fall back to a readable type", () => {
  expect(identityProviderLabel({ name: "", type: "onetimepin" })).toBe("One-time PIN");
  expect(identityProviderLabel({ name: "  ", type: "cloudflare" })).toBe("Cloudflare");
  expect(identityProviderLabel({ name: "Okta", type: "okta" })).toBe("Okta");
  expect(identityProviderLabel({ name: "Work SSO", type: "saml" })).toBe("Work SSO · SAML");
  expect(identityProviderLabel({ name: "", type: "custom" })).toBe("custom");
});

test("tunnel and share states map to status tones", () => {
  expect(tunnelTone("healthy")).toBe("good");
  expect(tunnelTone("degraded")).toBe("warn");
  expect(tunnelTone("down")).toBe("bad");
  expect(tunnelTone("inactive")).toBe("neutral");
  expect(shareTone("running")).toBe("good");
  expect(shareTone("starting")).toBe("warn");
  expect(shareTone("partial")).toBe("bad");
  expect(shareTone("stopped")).toBe("neutral");
});

test("connection labels never capitalise mid-sentence words", () => {
  const oauth = {
    configured: true,
    connected: true,
    accountId: "a",
    clientId: "c",
    redirectUri: "https://bb.example/cb",
    missing: [],
  };
  expect(connectionLabel(oauth, false)).toBe("Connected");
  expect(connectionLabel(oauth, true)).toBe("Partial access");
  expect(connectionLabel({ ...oauth, connected: false }, false)).toBe("Not connected");
  expect(connectionLabel({ ...oauth, configured: false }, false)).toBe("Setup required");
});

test("DNS filters combine zone, type and free text", () => {
  const records = [
    record({ id: "a", name: "example.com", type: "A" }),
    record({ id: "b", name: "blog.example.com", type: "CNAME", content: "pages.dev" }),
    record({ id: "c", zoneId: "z2", zoneName: "other.dev", name: "other.dev", type: "TXT" }),
  ];
  expect(dnsTypes(records)).toEqual(["A", "CNAME", "TXT"]);
  const ids = (matches: DnsRecord[]) => matches.map((item) => item.id);
  expect(ids(filterDnsRecords(records, { query: "", zoneId: "", type: "" }))).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(ids(filterDnsRecords(records, { query: "", zoneId: "z2", type: "" }))).toEqual(["c"]);
  expect(ids(filterDnsRecords(records, { query: "", zoneId: "", type: "CNAME" }))).toEqual(["b"]);
  expect(ids(filterDnsRecords(records, { query: "PAGES", zoneId: "", type: "" }))).toEqual(["b"]);
  expect(ids(filterDnsRecords(records, { query: "blog", zoneId: "z2", type: "" }))).toEqual([]);
});

test("unknown sub-paths fall back to the shares tab", () => {
  expect(activeTab("").path).toBe("");
  expect(activeTab("dns/anything").path).toBe("dns");
  expect(activeTab("nope").path).toBe("");
});
