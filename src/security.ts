import type { Env } from "./types";

function constantTimeEquals(supplied: string | null | undefined, expected: string | undefined): boolean {
  if (!expected || !supplied || supplied.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    mismatch |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

export function isAuthorized(request: Request, env: Env): boolean {
  const bearer = request.headers.get("authorization");
  const supplied = bearer?.startsWith("Bearer ")
    ? bearer.slice(7)
    : request.headers.get("x-directory-engine-key");
  return constantTimeEquals(supplied, env.DIRECTORY_ENGINE_API_KEY);
}

// Restores the write-key check that is already live in production
// (deployed directly via the dashboard as v0.3.0) but was never brought
// back into this repo -- see worker-multisite-scoping.md's note on the
// repo/production drift found while scoping the multi-site work.
export function isWriteAuthorized(request: Request, env: Env): boolean {
  const supplied = request.headers.get("x-directory-engine-write-key");
  return constantTimeEquals(supplied, env.DIRECTORY_ENGINE_WRITE_API_KEY);
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
    const pathname = new URL(request.url).pathname;
    const methods =
      pathname === "/mcp"
        ? "POST, OPTIONS"
        : pathname.startsWith("/v1/write/")
          ? "POST, PUT, DELETE, OPTIONS"
          : "GET, OPTIONS";
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", methods);
    headers.set(
      "access-control-allow-headers",
      "authorization, content-type, x-directory-engine-key, x-directory-engine-write-key, x-directory-engine-actor, x-request-id",
    );
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
