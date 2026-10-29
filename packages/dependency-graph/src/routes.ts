/**
 * Routes from framework file conventions (Next.js `app/` and `pages/` routers, middleware), and
 * matching of the URLs end-to-end specs visit against them.
 */
export interface RouteDef {
  /** Route pattern: "/users/*" (one segment), "/docs/**" (any depth). */
  route: string;
  file: string;
  /** "layout" and "middleware" apply to every route under `route`. */
  kind: "page" | "api" | "layout" | "middleware";
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

function segmentsToRoute(segs: string[]): string {
  const out: string[] = [];
  for (const s of segs) {
    if (!s || /^\(.*\)$/.test(s) || s.startsWith("@")) continue; // route groups, parallel slots
    if (/^\[\[?\.\.\..+\]\]?$/.test(s)) out.push("**");
    else if (/^\[.+\]$/.test(s)) out.push("*");
    else out.push(s);
  }
  return `/${out.join("/")}`;
}

/** Next.js routes of the projects rooted at `nextRoots` (directories, "" for the repository root). */
export function nextRoutes(files: readonly string[], nextRoots: readonly string[]): RouteDef[] {
  const out: RouteDef[] = [];
  for (const root of nextRoots) {
    const pre = root ? `${root}/` : "";
    for (const base of [`${pre}app/`, `${pre}src/app/`]) {
      for (const f of files) {
        if (!f.startsWith(base) || !SOURCE.test(f)) continue;
        const rel = f.slice(base.length);
        const segs = rel.split("/");
        const name = (segs.pop() as string).replace(SOURCE, "");
        const route = segmentsToRoute(segs);
        if (name === "page") out.push({ route, file: f, kind: "page" });
        else if (name === "route") out.push({ route, file: f, kind: "api" });
        else if (["layout", "template", "loading", "error", "not-found"].includes(name))
          out.push({ route, file: f, kind: "layout" });
      }
    }
    for (const base of [`${pre}pages/`, `${pre}src/pages/`]) {
      for (const f of files) {
        if (!f.startsWith(base) || !SOURCE.test(f)) continue;
        const segs = f.slice(base.length).replace(SOURCE, "").split("/");
        const last = segs.at(-1) as string;
        if (/^_(app|document|error)$/.test(last)) {
          out.push({ route: "/", file: f, kind: "layout" });
          continue;
        }
        if (last === "index") segs.pop();
        out.push({
          route: segmentsToRoute(segs),
          file: f,
          kind: segs[0] === "api" ? "api" : "page",
        });
      }
    }
    for (const m of [`${pre}middleware`, `${pre}src/middleware`])
      for (const f of files)
        if (f.startsWith(m) && SOURCE.test(f) && f.replace(SOURCE, "") === m)
          out.push({ route: "/", file: f, kind: "middleware" });
  }
  return out;
}

const split = (r: string) =>
  r
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);

/**
 * Whether a visited URL ("/users/42", or "/users/*" for a template with a dynamic tail) can be
 * served by a route pattern.
 */
export function routeMatches(visited: string, pattern: string): boolean {
  const prefix =
    visited.endsWith("*") && !visited.endsWith("/*") ? visited.slice(0, -1) : undefined;
  const v = split(prefix ?? visited);
  const p = split(pattern);
  if (prefix !== undefined) {
    // Dynamic tail: the known prefix must be compatible with the start of the pattern.
    const partial = !prefix.endsWith("/") && v.length ? v.pop() : undefined;
    for (let i = 0; i < v.length; i++) {
      const ps = p[i];
      if (ps === undefined) return false;
      if (ps === "**") return true;
      if (ps !== "*" && ps !== v[i]) return false;
    }
    if (partial !== undefined) {
      const ps = p[v.length];
      return ps === "*" || ps === "**" || (ps?.startsWith(partial) ?? false);
    }
    return p.length > v.length || p.at(-1) === "**" || v.length === p.length;
  }
  for (let i = 0; i < Math.max(v.length, p.length); i++) {
    const ps = p[i];
    if (ps === "**") return true;
    if (ps === undefined || v[i] === undefined) return false;
    if (ps !== "*" && ps !== v[i] && v[i] !== "*") return false;
  }
  return true;
}

/** Layouts and middleware apply to the routes at or below their own route. */
export function routeUnder(route: string, scope: string): boolean {
  const r = split(route);
  const s = split(scope);
  return s.every(
    (seg, i) => seg === r[i] || seg === "*" || seg === "**" || r[i] === "*" || r[i] === "**",
  );
}
