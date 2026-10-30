import { describe, expect, it } from "vitest";
import {
  assertLoopbackHost,
  checkApiRequest,
  checkHost,
  createSessionToken,
  hostnameOf,
  isLoopbackHostname,
  originAllowed,
  originsFor,
  portOf,
  type SecurityPolicy,
  TOKEN_HEADER,
  tokensMatch,
} from "./security.js";

const TOKEN = "test-token-value";
const policy: SecurityPolicy = {
  token: TOKEN,
  port: 4173,
  allowedOrigins: originsFor("127.0.0.1", 4173, ["localhost"]),
};

const request = (method: string, headers: Record<string, string>) => ({
  method,
  headers: { host: "127.0.0.1:4173", [TOKEN_HEADER]: TOKEN, ...headers },
});

const verdict = (method: string, headers: Record<string, string> = {}) =>
  checkApiRequest(request(method, headers), policy);

describe("session token", () => {
  it("creates a 256-bit URL-safe token", () => {
    const token = createSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createSessionToken()).not.toBe(token);
  });

  it("compares in constant time and never throws on a length mismatch", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(tokensMatch(TOKEN, "short")).toBe(false);
    expect(tokensMatch(TOKEN, undefined)).toBe(false);
    expect(tokensMatch(TOKEN, "")).toBe(false);
  });
});

describe("loopback binding", () => {
  it.each(["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"])("accepts %s", (host) => {
    expect(() => assertLoopbackHost(host)).not.toThrow();
  });

  it.each(["0.0.0.0", "::", "192.168.1.4", "example.com", "127.0.0.1.evil.com"])(
    "refuses %s",
    (host) => {
      expect(() => assertLoopbackHost(host)).toThrowError(
        expect.objectContaining({ code: "ST_STUDIO_BIND" }),
      );
    },
  );

  it("parses host names and ports, including brackets", () => {
    expect(hostnameOf("localhost:4173")).toBe("localhost");
    expect(hostnameOf("[::1]:4173")).toBe("::1");
    expect(portOf("[::1]:4173")).toBe(4173);
    expect(portOf("localhost")).toBeUndefined();
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
  });
});

describe("Host header", () => {
  it("accepts the loopback names and Studio's port", () => {
    expect(checkHost("127.0.0.1:4173", 4173).ok).toBe(true);
    expect(checkHost("localhost:4173", 4173).ok).toBe(true);
    expect(checkHost("localhost", 4173).ok).toBe(true);
    expect(checkHost("[::1]:4173", 4173).ok).toBe(true);
  });

  it("rejects rebinding attempts and a mismatched port", () => {
    expect(checkHost("evil.example:4173", 4173)).toMatchObject({
      ok: false,
      status: 403,
      code: "ST_STUDIO_HOST",
    });
    expect(checkHost("127.0.0.1:9999", 4173)).toMatchObject({ ok: false, status: 403 });
    expect(checkHost(undefined, 4173)).toMatchObject({ ok: false, status: 400 });
  });
});

describe("origins", () => {
  it("allows only Studio's own origins on the exact port", () => {
    expect(originAllowed("http://127.0.0.1:4173", policy.allowedOrigins)).toBe(true);
    expect(originAllowed("http://localhost:4173", policy.allowedOrigins)).toBe(true);
    expect(originAllowed("http://127.0.0.1:4174", policy.allowedOrigins)).toBe(false);
    expect(originAllowed("https://127.0.0.1:4173", policy.allowedOrigins)).toBe(false);
    expect(originAllowed("http://evil.example:4173", policy.allowedOrigins)).toBe(false);
    expect(originAllowed("null", policy.allowedOrigins)).toBe(false);
    expect(originAllowed("not a url", policy.allowedOrigins)).toBe(false);
  });
});

describe("API request checks", () => {
  it("accepts a token-authenticated GET without an Origin", () => {
    expect(verdict("GET")).toEqual({ ok: true, status: 200, code: "", message: "", hint: null });
    expect(verdict("HEAD", { "sec-fetch-site": "none" }).ok).toBe(true);
  });

  it("accepts the token in a Bearer header when the Studio header is absent", () => {
    const result = checkApiRequest(
      { method: "GET", headers: { host: "127.0.0.1:4173", authorization: `Bearer ${TOKEN}` } },
      policy,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a missing or wrong token", () => {
    expect(verdict("GET", { [TOKEN_HEADER]: "" })).toMatchObject({
      ok: false,
      status: 401,
      code: "ST_STUDIO_TOKEN",
    });
    expect(verdict("GET", { [TOKEN_HEADER]: "guess" })).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects cross-site and same-site requests", () => {
    expect(verdict("GET", { "sec-fetch-site": "cross-site" })).toMatchObject({
      ok: false,
      status: 403,
      code: "ST_STUDIO_ORIGIN",
    });
    expect(verdict("GET", { "sec-fetch-site": "same-site" })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("rejects a foreign Origin even on a read", () => {
    expect(verdict("GET", { origin: "http://evil.example" })).toMatchObject({
      ok: false,
      status: 403,
      code: "ST_STUDIO_ORIGIN",
    });
    expect(verdict("GET", { origin: "null" })).toMatchObject({ ok: false, status: 403 });
  });

  it("requires an Origin, JSON content type and a token for POST", () => {
    expect(verdict("POST", { "content-type": "application/json" })).toMatchObject({
      ok: false,
      status: 403,
      code: "ST_STUDIO_ORIGIN",
    });
    expect(
      verdict("POST", { origin: "http://127.0.0.1:4173", "content-type": "text/plain" }),
    ).toMatchObject({ ok: false, status: 415, code: "ST_STUDIO_CONTENT_TYPE" });
    expect(
      verdict("POST", { origin: "http://127.0.0.1:4173", "content-type": "application/json" }),
    ).toEqual({ ok: true, status: 200, code: "", message: "", hint: null });
  });

  it("rejects methods that no route can use", () => {
    expect(verdict("PUT")).toMatchObject({ ok: false, status: 405, code: "ST_STUDIO_METHOD" });
    expect(verdict("DELETE")).toMatchObject({ ok: false, status: 405 });
    expect(verdict("OPTIONS", { origin: "http://127.0.0.1:4173" })).toMatchObject({
      ok: false,
      status: 405,
    });
  });
});
