/**
 * Server routes read from a framework's route files (Laravel's `Route::get(…)`, preview) and the
 * requests tests make (`$this->getJson('/api/posts/1')`, `route('posts.show')`), as resources:
 *
 * - a route definition is a symbol of its route file carrying `http-route:<METHODS> <uri>` (and
 *   `http-route-name:<name>`); `~` after the kind marks a route whose prefix is not known (a route
 *   file another one includes inside a group): it matches a request ending with its uri;
 * - a request is `http-request:<METHOD> <url>` (`*` where the url is computed) or
 *   `http-request-name:<name>` on the test symbol that makes it.
 *
 * A request links the test to the routes that can serve it, so a change behind one route reaches
 * the tests that request it, not every test that boots the application.
 */

export interface RouteDefinition {
  file: string;
  unit: string;
  /** Upper-case methods; "*" for any. */
  methods: string[];
  /** Path segments of the uri (`{param}` kept); undefined: matches any path (an unread route). */
  segments?: string[];
  open: boolean;
  names: string[];
  namesOpen: boolean;
}

export const ROUTE_DEF = "http-route";
export const ROUTE_NAME = "http-route-name";
export const REQUEST = "http-request";
export const REQUEST_NAME = "http-request-name";

const segmentsOf = (path: string) =>
  path
    .replace(/[?#].*$/, "")
    .split("/")
    .filter(Boolean);

/** Reads a definition resource (`http-route:GET|HEAD /api/x`, `http-route~:POST /x`). */
export function parseRouteResource(
  r: string,
): Omit<RouteDefinition, "file" | "unit" | "names" | "namesOpen"> | undefined {
  const m = /^http-route(~?):(\S+) (.*)$/.exec(r);
  if (!m) return undefined;
  return {
    methods: (m[2] as string).split("|"),
    ...((m[3] as string) === "*" ? {} : { segments: segmentsOf(m[3] as string) }),
    open: m[1] === "~",
  };
}

const isParam = (s: string) => /^\{[^}]+\}$/.test(s);
const optional = (s: string) => /^\{[^}]+\?\}$/.test(s);

/** Whether a definition's segment can be the request's literal segment. */
const segmentMatches = (def: string, req: string) =>
  isParam(def) || def.toLowerCase() === req.toLowerCase();

/**
 * Whether a request path (`*` = any text) can be served by a definition. A `*` in a request
 * segment matches the rest of the path, whatever it is (a computed suffix): conservative.
 */
export function pathMatches(
  def: readonly string[],
  request: readonly string[],
  open: boolean,
): boolean {
  const required = def.filter((s) => !optional(s)).length;
  const tryAt = (offset: number): boolean => {
    for (let i = 0; i < request.length; i++) {
      const r = request[i] as string;
      const d = def[i - offset];
      if (i < offset) continue;
      if (r.includes("*")) {
        const before = r.slice(0, r.indexOf("*"));
        if (d === undefined) return true;
        return isParam(d) || d.toLowerCase().startsWith(before.toLowerCase());
      }
      if (d === undefined) return false;
      if (!segmentMatches(d, r)) return false;
    }
    const used = request.length - offset;
    return used >= required && used <= def.length;
  };
  if (!open) return tryAt(0);
  // A route whose prefix is unknown: it may serve any request ending with its own path.
  for (let offset = 0; offset <= request.length; offset++) if (tryAt(offset)) return true;
  return request.some((r) => r.includes("*"));
}

/** The definitions a request resource can reach. */
export function matchRequest(r: string, defs: readonly RouteDefinition[]): RouteDefinition[] {
  const byName = /^http-request-name:(.+)$/.exec(r);
  if (byName) {
    const name = byName[1] as string;
    return defs.filter((d) =>
      d.names.some(
        (n) => n === name || (d.namesOpen && name.endsWith(`.${n}`)) || (d.namesOpen && name === n),
      ),
    );
  }
  const m = /^http-request:(\S+) (.*)$/.exec(r);
  if (!m) return [];
  const method = (m[1] as string).toUpperCase();
  const path = segmentsOf((m[2] as string).replace(/^https?:\/\/[^/]*/i, "").replace(/\?.*$/, ""));
  return defs.filter(
    (d) =>
      (d.methods.includes("*") ||
        d.methods.includes(method) ||
        (method === "HEAD" && d.methods.includes("GET"))) &&
      (!d.segments || pathMatches(d.segments, path, d.open)),
  );
}
