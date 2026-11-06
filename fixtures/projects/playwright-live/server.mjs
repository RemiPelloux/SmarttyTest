// The local application the `local` project tests (started by Playwright's webServer).
import { createServer } from "node:http";
import { greeting } from "./lib/greeting.js";
import { status } from "./lib/status.js";

const port = Number(process.argv[2] ?? 3200);

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/api/status") return res.end(JSON.stringify(status()));
  if (url.pathname === "/api/greeting")
    return res.end(JSON.stringify({ text: greeting(url.searchParams.get("name") ?? "") }));
  res.statusCode = 404;
  res.end("{}");
}).listen(port, "127.0.0.1");
