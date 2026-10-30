/**
 * Small HTTP helpers for Studio: JSON responses, static files, request bodies.
 * No framework, no middleware chain — the routes are a table in `server.ts`.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  // The app is plain scripts and styles served by Studio; no inline code, no eval, no framing.
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
};

export function setBaseHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  res.setHeader("Cache-Control", "no-store");
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  hint: string | null = null,
): void {
  sendJson(res, status, { error: { code, message, hint } });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export function contentTypeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Serves a file only if it exists and is a regular file; the caller has already contained the path. */
export async function sendFile(
  res: ServerResponse,
  absPath: string,
  cache = "no-cache",
  extraHeaders: Record<string, string> = {},
): Promise<boolean> {
  const info = await stat(absPath).catch(() => null);
  if (!info?.isFile()) return false;
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypeOf(absPath));
  res.setHeader("Content-Length", info.size);
  res.setHeader("Cache-Control", cache);
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absPath);
    stream.on("error", reject);
    stream.on("end", resolve);
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  });
  return true;
}

export const MAX_BODY_BYTES = 64 * 1024;

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES)
      throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON"), { status: 400 });
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" ? value : undefined;
}

export function booleanField(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  return typeof value === "boolean" ? value : undefined;
}

export function numberField(body: Record<string, unknown>, name: string): number | undefined {
  const value = body[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** SSE write helper: a single JSON message per default `message` event. */
export function sseWrite(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
