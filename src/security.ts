import type { Env } from "./types";

export function isAuthorized(request: Request, env: Env): boolean {
  if (!env.DIRECTORY_ENGINE_API_KEY) return false;
  const bearer = request.headers.get("authorization");
  const supplied = bearer?.startsWith("Bearer ")
    ? bearer.slice(7)
    : request.headers.get("x-directory-engine-key");
  if (!supplied || supplied.length !== env.DIRECTORY_ENGINE_API_KEY.length) return false;

  let mismatch = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    mismatch |= supplied.charCodeAt(index) ^ env.DIRECTORY_ENGINE_API_KEY.charCodeAt(index);
  }
  return mismatch === 0;
}

export function corsHeaders(request: Request, env: Env): Headers {
  const requestId = request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();
  const headers = new Headers({
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
  const origin = request.headers.get("origin");
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (origin && allowed.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set(
      "access-control-allow-methods",
      new URL(request.url).pathname === "/mcp" ? "POST, OPTIONS" : "GET, OPTIONS",
    );
    headers.set("access-control-allow-headers", "authorization, content-type, x-directory-engine-key, x-request-id");
    headers.set("access-control-max-age", "86400");
    headers.append("vary", "Origin");
  }
  return headers;
}

export function jsonResponse(
  request: Request,
  env: Env,
  value: unknown,
  init: ResponseInit = {},
): Response {
  const headers = corsHeaders(request, env);
  headers.set("content-type", "application/json; charset=utf-8");
  if (init.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(value), { ...init, headers });
}
