import { describe, it, expect } from "vitest";
import { seg, isPrivateIp, assertPublicHttpUrl, CreateMessageSchema, MeSchema, directionQuery } from "./api";

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
    // Hex-serialized IPv4-mapped form — how Node actually normalizes
    // ::ffff:127.0.0.1 / the cloud-metadata IP. The old dotted-only regex missed
    // these, so they reached the proxy as "public" (SSRF).
    "::ffff:7f00:1", "::ffff:a9fe:a9fe",
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

  it("accepts a public IP-literal host and pins to its validated IP", async () => {
    const { url, ips } = await assertPublicHttpUrl("https://8.8.8.8/logo.png");
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe("8.8.8.8");
    expect(ips).toContain("8.8.8.8");
  });

  it("rejects non-web ports so the proxy cannot probe public services", async () => {
    // The private-range check constrains WHICH host we reach, not which port. Without
    // a port check these all pass it and we then open a TCP connection and write an
    // HTTP request at whatever is listening — a port scanner wearing our IP.
    await expect(assertPublicHttpUrl("https://8.8.8.8:22/x")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://8.8.8.8:25/x")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://8.8.8.8:3306/x")).rejects.toThrow();
  });

  it("still accepts the default and explicit web ports", async () => {
    await expect(assertPublicHttpUrl("https://8.8.8.8/x")).resolves.toBeTruthy();
    await expect(assertPublicHttpUrl("https://8.8.8.8:443/x")).resolves.toBeTruthy();
    await expect(assertPublicHttpUrl("http://8.8.8.8:80/x")).resolves.toBeTruthy();
  });
});

describe("MeSchema — profile update / password policy", () => {
  it("accepts a name-only update", () => {
    expect(MeSchema.safeParse({ name: "Test User" }).success).toBe(true);
  });

  it("requires the current password to set a new one", () => {
    expect(MeSchema.safeParse({ password: "hunter2secret" }).success).toBe(false);
    expect(MeSchema.safeParse({ password: "hunter2secret", existingPassword: "old" }).success).toBe(true);
  });

  it("enforces the same minimum length the browser does", () => {
    // The client checks length >= 6, but that is a UX affordance: a direct API call
    // used to be able to set a one-character password.
    expect(MeSchema.safeParse({ password: "a", existingPassword: "old" }).success).toBe(false);
    expect(MeSchema.safeParse({ password: "abcdef", existingPassword: "old" }).success).toBe(true);
  });

  it("rejects an empty password instead of silently treating it as no-change", () => {
    // "" satisfied `!body.password` in the refine, so it passed without an
    // existingPassword — and the handler's `password != null` check then still tried
    // to apply it. Failing validation removes the ambiguity entirely.
    expect(MeSchema.safeParse({ password: "" }).success).toBe(false);
  });

  it("strips fields the webmail is not allowed to set", () => {
    const parsed = MeSchema.safeParse({ name: "Test", quota: 999, disabled: true });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ name: "Test" });
  });
});

describe("CreateMessageSchema — draft send round-trip (reply/forward)", () => {
  it("accepts a reply draft whose WildDuck-returned reference omits `attachments`", () => {
    // On send, raven re-POSTs a draft it re-GET'd from WildDuck. WildDuck returns
    // `reference` as {mailbox,id,action} WITHOUT the creation-only `attachments`, so
    // requiring it previously 400'd (bad_request) every reply/forward send.
    const body = {
      draft: true,
      to: [{ address: "sophie@example.com", name: "Sophie" }],
      subject: "Re: hi",
      html: "<p>hi</p>",
      text: "hi",
      reference: { mailbox: "69944ab361bb634839a3b7c3", id: 88, action: "reply" },
    };
    expect(() => CreateMessageSchema.parse(body)).not.toThrow();
  });

  it("still accepts the full reference raven sends at draft-creation time", () => {
    const body = { reference: { mailbox: "69944ab361bb634839a3b7c3", id: 88, action: "forward", attachments: true } };
    expect(() => CreateMessageSchema.parse(body)).not.toThrow();
  });

  it("accepts reference.attachments as an array of ids (WildDuck's alternative form)", () => {
    const body = { reference: { mailbox: "69944ab361bb634839a3b7c3", id: 1, action: "reply", attachments: ["ATT00001"] } };
    expect(() => CreateMessageSchema.parse(body)).not.toThrow();
  });

  it("accepts a recipient with a null display name (WildDuck's no-name form)", () => {
    expect(() => CreateMessageSchema.parse({ to: [{ address: "a@b.com", name: null }] })).not.toThrow();
  });

  it("strips unknown top-level keys so a client cannot mass-assign WildDuck fields", () => {
    const parsed: any = CreateMessageSchema.parse({ subject: "hi", quota: 999, disabled: true, spamLevel: 0 });
    expect(parsed).not.toHaveProperty("quota");
    expect(parsed).not.toHaveProperty("disabled");
    expect(parsed).not.toHaveProperty("spamLevel");
  });

  it("still rejects a reference with a non-numeric id", () => {
    const body = { reference: { mailbox: "x", id: "not-a-number", action: "reply" } };
    expect(() => CreateMessageSchema.parse(body)).toThrow();
  });
});

describe("directionQuery() — direction filter built server-side", () => {
  const MB = "615c1f2e4a3b9c0d7e8f1a2b";
  const ME = ["kiki@red-code.dev"];

  it("asks for mail from the account itself when filtering outgoing", () => {
    expect(directionQuery(MB, ME, "out")).toBe(`mailbox:${MB} from:kiki@red-code.dev`);
  });

  it("negates the same term for incoming", () => {
    // The half that cannot be expressed with WildDuck's structured from/to params and
    // is the whole reason this goes through `q`.
    expect(directionQuery(MB, ME, "in")).toBe(`mailbox:${MB} -from:kiki@red-code.dev`);
  });

  it("does NOT quote the address", () => {
    // logic-query-parser splits `from:"a@b.c"` into `from:` and a bare `a@b.c`, which
    // WildDuck then reads as a FULLTEXT term — the filter quietly stops being a sender
    // filter. Quoting here looks careful and is the bug.
    expect(directionQuery(MB, ME, "out")).not.toContain('"');
  });

  it("scopes every branch to the mailbox when the account has aliases", () => {
    // The parser has no parentheses and binds `and` tighter than `or`, so a single
    // leading selector — `mailbox:X from:a or from:b` — leaves the second alias
    // unscoped and matching across the whole account. Repeating it is the fix.
    const q = directionQuery(MB, ["a@x.com", "b@x.com"], "out");
    expect(q).toBe(`mailbox:${MB} from:a@x.com or mailbox:${MB} from:b@x.com`);
  });

  it("excludes every alias for incoming", () => {
    expect(directionQuery(MB, ["a@x.com", "b@x.com"], "in"))
      .toBe(`mailbox:${MB} -from:a@x.com -from:b@x.com`);
  });

  it("refuses an address that would be read as syntax", () => {
    // Whitespace splits the token and a quote starts a phrase; neither can be escaped,
    // so such an address is dropped rather than silently widening the filter.
    expect(directionQuery(MB, ['bad addr@x.com', "ok@x.com"], "out"))
      .toBe(`mailbox:${MB} from:ok@x.com`);
    expect(() => directionQuery(MB, ['bad addr@x.com'], "out")).toThrow();
  });
});
