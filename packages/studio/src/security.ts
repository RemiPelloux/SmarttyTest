/**
 * Studio security (roadmap 0.9.0, risk R8; PRD §28.2).
 *
 * Studio is a local process that can read a repository and start test runners, so it is treated as
 * a privileged local service rather than a development convenience:
 *
 * 1. It binds to a loopback address only. `0.0.0.0` is refused, not warned about.
 * 2. Every API call needs the session token, compared in constant time. The token lives in the URL
 *    fragment (never sent to a server, never logged) and is kept in the tab's sessionStorage.
 * 3. Requests that carry an `Origin` must come from the Studio origin itself. Cross-site
 *    `Sec-Fetch-Site` values are refused, and no CORS headers are ever written.
 * 4. The `Host` header must be a loopback name, which closes DNS-rebinding.
 * 5. State-changing calls must be `POST` with `application/json`, so a cross-origin form or a
 *    simple request cannot reach them without a preflight Studio never answers.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { SmartTestError } from "@smarttest/shared";

export const TOKEN_HEADER = "x-smarttest-token";

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time token comparison; a length difference still costs one comparison. */
export function tokensMatch(expected: string, given: string | undefined): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given ?? "", "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(1, end);
  }
  const colon = value.lastIndexOf(":");
  const host = colon === -1 ? value : value.slice(0, colon);
  return host;
}

export function portOf(hostHeader: string | undefined): number | undefined {
  if (!hostHeader) return undefined;
  const value = hostHeader.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return undefined;
    const rest = value.slice(end + 1);
    if (!rest.startsWith(":")) return undefined;
    return Number(rest.slice(1)) || undefined;
  }
  const colon = value.lastIndexOf(":");
  if (colon === -1) return undefined;
  return Number(value.slice(colon + 1)) || undefined;
}

/** `localhost`, any `127.x.y.z`, and `::1`. Nothing else reaches the server. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Refuses to start on anything but loopback: a LAN address would expose the repository. */
export function assertLoopbackHost(host: string): void {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!isLoopbackHostname(bare)) {
    throw new SmartTestError(`Studio refuses to bind ${host}: it only listens on loopback`, {
      code: "ST_STUDIO_BIND",
      category: "usage",
      hint: "Use 127.0.0.1 or ::1. A Studio reachable from the network would expose the repository.",
    });
  }
}

export interface AllowedOrigin {
  protocol: "http:";
  hostname: string;
  port: number;
}

export function originsFor(
  host: string,
  port: number,
  extraHosts: readonly string[] = [],
): AllowedOrigin[] {
  const hosts = new Set<string>([hostnameOf(host), ...extraHosts.map((h) => hostnameOf(h))]);
  hosts.delete("");
  if (hosts.has("127.0.0.1")) hosts.add("localhost");
  if (hosts.has("localhost")) hosts.add("127.0.0.1");
  if (hosts.has("::1")) hosts.add("[::1]");
  return [...hosts].map((hostname) => ({ protocol: "http:" as const, hostname, port }));
}

export function originAllowed(origin: string, allowed: readonly AllowedOrigin[]): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const port = Number(url.port || "80");
  return allowed.some(
    (a) =>
      a.port === port &&
      (a.hostname === url.hostname ||
        // URL.hostname for IPv6 is unbracketed while originsFor keeps both forms.
        a.hostname.replace(/^\[|\]$/g, "") === url.hostname),
  );
}

export interface SecurityPolicy {
  token: string;
  port: number;
  allowedOrigins: readonly AllowedOrigin[];
}

export interface SecurityVerdict {
  ok: boolean;
  status: number;
  code: string;
  message: string;
  hint: string | null;
}

const OK: SecurityVerdict = { ok: true, status: 200, code: "", message: "", hint: null };

/** Host header check, shared by static files and API routes (DNS-rebinding defence). */
export function checkHost(hostHeader: string | undefined, port: number): SecurityVerdict {
  const hostname = hostnameOf(hostHeader);
  if (!hostHeader || !hostname) {
    return {
      ok: false,
      status: 400,
      code: "ST_STUDIO_HOST",
      message: "Missing Host header",
      hint: null,
    };
  }
  if (!isLoopbackHostname(hostname)) {
    return {
      ok: false,
      status: 403,
      code: "ST_STUDIO_HOST",
      message: `Host ${hostname} is not a loopback name`,
      hint: "Open Studio through 127.0.0.1 or localhost.",
    };
  }
  const hostPort = portOf(hostHeader);
  if (hostPort !== undefined && hostPort !== port) {
    return {
      ok: false,
      status: 403,
      code: "ST_STUDIO_HOST",
      message: `Host port ${hostPort} does not match Studio's port ${port}`,
      hint: null,
    };
  }
  return OK;
}

export interface RequestLike {
  method?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

function headerOf(req: RequestLike, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Full check for `/api/**`. */
export function checkApiRequest(req: RequestLike, policy: SecurityPolicy): SecurityVerdict {
  const host = checkHost(headerOf(req, "host"), policy.port);
  if (!host.ok) return host;

  const fetchSite = headerOf(req, "sec-fetch-site");
  if (fetchSite === "cross-site" || fetchSite === "same-site") {
    return {
      ok: false,
      status: 403,
      code: "ST_STUDIO_ORIGIN",
      message: `Refusing a ${fetchSite} request`,
      hint: "Studio answers only its own tab.",
    };
  }

  const origin = headerOf(req, "origin");
  if (origin && !originAllowed(origin, policy.allowedOrigins)) {
    return {
      ok: false,
      status: 403,
      code: "ST_STUDIO_ORIGIN",
      message: `Origin ${origin} is not Studio's origin`,
      hint: "Open Studio from the URL the command printed.",
    };
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    return {
      ok: false,
      status: 405,
      code: "ST_STUDIO_METHOD",
      message: `Method ${method} is not allowed`,
      hint: null,
    };
  }

  if (method === "POST") {
    if (origin === undefined) {
      return {
        ok: false,
        status: 403,
        code: "ST_STUDIO_ORIGIN",
        message: "State-changing calls must come from a browser page with an Origin",
        hint: null,
      };
    }
    const contentType = (headerOf(req, "content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return {
        ok: false,
        status: 415,
        code: "ST_STUDIO_CONTENT_TYPE",
        message: "State-changing calls must send application/json",
        hint: null,
      };
    }
  }

  const given =
    headerOf(req, TOKEN_HEADER) ??
    (headerOf(req, "authorization")?.startsWith("Bearer ")
      ? headerOf(req, "authorization")?.slice(7)
      : undefined);
  if (!tokensMatch(policy.token, given)) {
    return {
      ok: false,
      status: 401,
      code: "ST_STUDIO_TOKEN",
      message: "Missing or invalid Studio session token",
      hint: "Reopen the URL printed by `smarttest studio`.",
    };
  }
  return OK;
}
