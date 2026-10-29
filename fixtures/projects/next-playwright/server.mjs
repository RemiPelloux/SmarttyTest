// Minimal server for the app/ directory using Next.js file conventions: page.js, layout.js,
// [param] folders and route.js handlers.
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const APP = join(import.meta.dirname, "app");

function resolve(segments) {
  let dir = APP;
  const params = {};
  for (const seg of segments) {
    if (existsSync(join(dir, seg))) dir = join(dir, seg);
    else {
      const dyn = readdirSync(dir).find((d) => /^\[.+\]$/.test(d));
      if (!dyn) return undefined;
      params[dyn.slice(1, -1)] = seg;
      dir = join(dir, dyn);
    }
  }
  return { dir, params };
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const hit = resolve(url.pathname.split("/").filter(Boolean));
  if (hit && existsSync(join(hit.dir, "route.js"))) {
    const mod = await import(pathToFileURL(join(hit.dir, "route.js")).href);
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(mod.GET(hit.params)));
  }
  if (!hit || !existsSync(join(hit.dir, "page.js"))) {
    res.statusCode = 404;
    return res.end("not found");
  }
  const page = await import(pathToFileURL(join(hit.dir, "page.js")).href);
  const layout = await import(pathToFileURL(join(APP, "layout.js")).href);
  res.setHeader("content-type", "text/html");
  res.end(layout.default(page.default(hit.params)));
}).listen(Number(process.env.PORT ?? 3123));
