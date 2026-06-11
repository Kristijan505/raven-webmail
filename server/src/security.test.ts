import { describe, it, expect } from "vitest";
import { seg, isPrivateIp, assertPublicHttpUrl } from "./api";

describe("seg() — path param hardening (cross-user IDOR / query injection)", () => {
  it("passes legitimate WildDuck ids through unchanged", () => {
    expect(seg("615c1f2e4a3b9c0d7e8f1a2b")).toBe("615c1f2e4a3b9c0d7e8f1a2b");
    expect(seg("12345")).toBe("12345");
  });

  it("rejects smuggled path separators (defeats /../ traversal to another user)", () => {
    expect(() => seg("../../VICTIM_ID/mailboxes/INBOX")).toThrow();
    expect(() => seg("a\\b")).toThrow();
  });

  it("rejects bare dot-segments the URL parser would collapse", () => {
    expect(() => seg("..")).toThrow();
    expect(() => seg(".")).toThrow();
  });

  it("rejects empty / non-string params (Express may give string[])", () => {
    expect(() => seg("")).toThrow();
    expect(() => seg(undefined)).toThrow();
    expect(() => seg(["a", "b"])).toThrow();
  });

  it("percent-encodes query/fragment delimiters so they cannot inject upstream params", () => {
    expect(seg("abc?foo=bar&limit=999")).toBe("abc%3Ffoo%3Dbar%26limit%3D999");
    expect(seg("a#b")).toBe("a%23b");
  });
});

describe("isPrivateIp() — image-proxy SSRF guard", () => {
  const blocked = [
    "127.0.0.1", "169.254.169.254", "10.0.0.5", "172.18.0.2", "192.168.1.1",
    "0.0.0.0", "100.64.0.1", "224.0.0.1",
    "::1", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
  ];
  const allowed = [
    "8.8.8.8", "1.1.1.1", "93.184.216.34", "151.101.0.1",
    "2606:2800:220:1:248:1893:25c8:1946",
  ];

  it.each(blocked)("blocks internal/loopback/private %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(allowed)("allows public %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });
});

describe("assertPublicHttpUrl() — image proxy URL validation", () => {
  it("rejects non-http(s) schemes and malformed urls", async () => {
    await expect(assertPublicHttpUrl("ftp://example.com/x")).rejects.toThrow();
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicHttpUrl("not a url")).rejects.toThrow();
  });

  it("rejects IP-literal hosts in private/loopback ranges", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1/x")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://[::1]/x")).rejects.toThrow();
  });

  it("accepts a public IP-literal host", async () => {
    const u = await assertPublicHttpUrl("https://8.8.8.8/logo.png");
    expect(u).toBeInstanceOf(URL);
    expect(u.hostname).toBe("8.8.8.8");
  });
});
