/**
 * Directory Engine API Worker v0.2.0 — preserved deployed REST baseline.
 *
 * This reference is intentionally not the Wrangler entry point. It contains
 * environment binding and secret names only; it contains no values.
 */

const VERSION = "0.2.0";
const MAX_UPSTREAM_BYTES = 1_048_576;
const MAX_UPSTREAM_ATTEMPTS = 3;
const UPSTREAM_TIMEOUT_MS = 10_000;
const QUERY_KEYS = new Set([
  "page", "per_page", "search", "slug", "status", "orderby", "order",
  "parent", "post", "post_type", "taxonomy", "country", "region", "city",
  "include", "exclude", "offset", "context",
]);
const GEO_PATHS = {
  "listing-types": "wp-json/geodir/v2/types",
  taxonomies: "wp-json/geodir/v2/taxonomies",
  fields: "wp-json/geodir/v2/fields",
  settings: "wp-json/geodir/v2/settings",
  locations: "wp-json/geodir/v2/locations",
  cities: "wp-json/geodir/v2/locations/cities",
};

function authorized(request, env) {
  if (!env.DIRECTORY_ENGINE_API_KEY) return false;
  const authorization = request.headers.get("authorization");
  const supplied = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : request.headers.get("x-directory-engine-key");
  if (!supplied || supplied.length !== env.DIRECTORY_ENGINE_API_KEY.length) return false;
  let mismatch = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    mismatch |= supplied.charCodeAt(index) ^ env.DIRECTORY_ENGINE_API_KEY.charCodeAt(index);
  }
  return mismatch === 0;
}

function responseHeaders(request, env) {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-request-id": request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID(),
  });
  const origin = request.headers.get("origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "GET, OPTIONS");
    headers.set("access-control-allow-headers", "authorization, content-type, x-directory-engine-key, x-request-id");
    headers.set("access-control-max-age", "86400");
    headers.set("vary", "Origin");
  }
  return headers;
}

function json(request, env, value, status = 200, extraHeaders) {
  const headers = responseHeaders(request, env);
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(value), { status, headers });
}

function wordpressBase(env) {
  if (!env.WORDPRESS_BASE_URL) throw new Error("WORDPRESS_BASE_URL is not configured");
  const url = new URL(env.WORDPRESS_BASE_URL.replace(/\/$/, "") + "/");
  if (url.protocol !== "https:") throw new Error("WORDPRESS_BASE_URL must use HTTPS");
  if (url.username || url.password) throw new Error("WORDPRESS_BASE_URL must not contain credentials");
  return url;
}

function filteredQuery(input) {
  const output = new URLSearchParams();
  input.forEach((value, key) => {
    if (!QUERY_KEYS.has(key) || value.length > 500) return;
    if (key === "per_page") {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1 || number > 100) return;
    }
    output.append(key, value);
  });
  return output;
}

async function wordpressGet(env, path, query = new URLSearchParams()) {
  const url = new URL(path, wordpressBase(env));
  url.search = query.toString();
  const headers = new Headers({ accept: "application/json" });
  if (env.GEODIRECTORY_CONSUMER_KEY && env.GEODIRECTORY_CONSUMER_SECRET) {
    headers.set("authorization", `Basic ${btoa(`${env.GEODIRECTORY_CONSUMER_KEY}:${env.GEODIRECTORY_CONSUMER_SECRET}`)}`);
  }
  let response;
  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    response = await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (response.status < 500 && response.status !== 429) break;
    if (attempt < MAX_UPSTREAM_ATTEMPTS) await response.body?.cancel();
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error("upstream redirect rejected");
  }
  if (Number(response.headers.get("content-length") || 0) > MAX_UPSTREAM_BYTES) {
    await response.body?.cancel();
    throw new Error("upstream response too large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_UPSTREAM_BYTES) throw new Error("upstream response too large");
  const text = new TextDecoder().decode(bytes);
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
  return body;
}

async function databaseStatus(env) {
  const row = await env.DIRECTORY_DB.prepare(`
    SELECT COUNT(*) AS table_count FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).first();
  return { connected: true, binding: "DIRECTORY_DB", table_count: row?.table_count || 0 };
}

async function databaseSchema(env) {
  const result = await env.DIRECTORY_DB.prepare(`
    SELECT m.name AS table_name, p.cid, p.name AS column_name, p.type,
           p."notnull" AS not_null, p.dflt_value AS default_value, p.pk AS primary_key
      FROM sqlite_schema AS m JOIN pragma_table_info(m.name) AS p
     WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
     ORDER BY m.name, p.cid
  `).all();
  const tables = {};
  for (const column of result.results || []) {
    const { table_name: tableName, ...definition } = column;
    (tables[tableName] ||= []).push(definition);
  }
  return { binding: "DIRECTORY_DB", tables };
}

async function connectionTest(env) {
  const settled = await Promise.allSettled([
    databaseStatus(env), wordpressGet(env, "wp-json/"), wordpressGet(env, "wp-json/geodir/v2/"),
  ]);
  const state = (result) => ({ connected: result.status === "fulfilled" });
  return { database: state(settled[0]), wordpress: state(settled[1]), geodirectory: state(settled[2]) };
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(request, env) });
  if (url.pathname === "/health" && request.method === "GET") {
    return json(request, env, { status: "ok", service: "directory-engine-api", version: VERSION });
  }
  if (!authorized(request, env)) return json(request, env, { error: "Unauthorized" }, 401);
  if (request.method !== "GET") return json(request, env, { error: "Method not allowed" }, 405, { allow: "GET, OPTIONS" });

  try {
    if (url.pathname === "/v1/capabilities") {
      return json(request, env, {
        service: "directory-engine-api", version: VERSION, read_only: true,
        database_binding: "DIRECTORY_DB",
      });
    }
    if (url.pathname === "/v1/connection-test") return json(request, env, await connectionTest(env));
    if (url.pathname === "/v1/database/status") return json(request, env, await databaseStatus(env));
    if (url.pathname === "/v1/database/schema") return json(request, env, await databaseSchema(env));
    const wordpress = url.pathname.match(/^\/v1\/wordpress\/(pages|posts|categories)(?:\/(\d+))?$/);
    if (wordpress) {
      const path = `wp-json/wp/v2/${wordpress[1]}${wordpress[2] ? `/${wordpress[2]}` : ""}`;
      return json(request, env, await wordpressGet(env, path, filteredQuery(url.searchParams)));
    }
    const geo = url.pathname.match(/^\/v1\/geodirectory\/(listing-types|taxonomies|fields|settings|locations|cities)$/);
    if (geo) return json(request, env, await wordpressGet(env, GEO_PATHS[geo[1]], filteredQuery(url.searchParams)));
    return json(request, env, { error: "Not found" }, 404);
  } catch {
    return json(request, env, { error: "Inspection request failed" }, 500);
  }
}

export default { fetch: handle };
