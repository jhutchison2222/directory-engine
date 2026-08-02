import { afterEach, describe, expect, it, vi } from "vitest";
import { route } from "../src/index";
import { MCP_TOOLS } from "../src/mcp";
import type { Env } from "../src/types";

function environment(): Env {
  return {
    DIRECTORY_ENGINE_API_KEY: "test-only-key",
    WORDPRESS_BASE_URL: "https://wordpress.test",
    GEODIRECTORY_CONSUMER_KEY: "consumer-key",
    GEODIRECTORY_CONSUMER_SECRET: "consumer-secret",
    ALLOWED_ORIGINS: "https://console.test",
    DIRECTORY_DB: {
      prepare(sql: string) {
        return {
          bind() { return this; },
          first: async () => ({ table_count: 21 }),
          all: async () => ({
            success: true,
            meta: {},
            results: sql.includes("pragma_table_info")
              ? [{ table_name: "wp_posts", cid: 0, column_name: "ID", type: "INTEGER", not_null: 1, default_value: null, primary_key: 1 }]
              : [],
          }),
        } as unknown as D1PreparedStatement;
      },
    } as D1Database,
  };
}

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-directory-engine-key", "test-only-key");
  return new Request(`https://worker.test${path}`, { ...init, headers });
}

async function payload(response: Response): Promise<any> {
  return response.json();
}

afterEach(() => vi.unstubAllGlobals());

describe("deployed v0.2.0 contract", () => {
  it("keeps health public and protects inspection routes", async () => {
    expect(await payload(await route(new Request("https://worker.test/health"), environment())))
      .toMatchObject({ status: "ok", version: "0.2.0" });
    const denied = await route(new Request("https://worker.test/v1/capabilities"), environment());
    expect(denied.status).toBe(401);
    expect(await payload(denied)).toEqual({ error: "Unauthorized" });
  });

  it("accepts both authoritative authentication headers and rejects incorrect keys", async () => {
    const bearer = await route(new Request("https://worker.test/v1/capabilities", {
      headers: { authorization: "Bearer test-only-key" },
    }), environment());
    expect(bearer.status).toBe(200);
    const named = await route(new Request("https://worker.test/v1/capabilities", {
      headers: { "X-Directory-Engine-Key": "test-only-key" },
    }), environment());
    expect(named.status).toBe(200);
    const wrong = await route(new Request("https://worker.test/v1/capabilities", {
      headers: { "X-Directory-Engine-Key": "incorrect-key" },
    }), environment());
    expect(wrong.status).toBe(401);
  });

  it("advertises the preserved routes, binding, and MCP tools", async () => {
    const response = await route(request("/v1/capabilities"), environment());
    const body = await payload(response);
    expect(body).toMatchObject({ version: "0.2.0", read_only: true, database_binding: "DIRECTORY_DB" });
    expect(body.routes.database).toEqual(["/v1/database/status", "/v1/database/schema"]);
    expect(body.routes.wordpress).toContain("/v1/wordpress/pages");
    expect(body.routes.geodirectory).toContain("/v1/geodirectory/listing-types");
    expect(body.routes.mcp).toBe("/mcp");
  });

  it("reports the existing 21-table database without creating a schema", async () => {
    const status = await payload(await route(request("/v1/database/status"), environment()));
    expect(status).toEqual({ connected: true, binding: "DIRECTORY_DB", table_count: 21 });
    const schema = await payload(await route(request("/v1/database/schema"), environment()));
    expect(schema.binding).toBe("DIRECTORY_DB");
    expect(schema.tables.wp_posts[0]).toMatchObject({ column_name: "ID", primary_key: 1 });
  });

  it("proxies only read-only WordPress and GeoDirectory GET routes", async () => {
    const fetchMock = vi.fn(async () => Response.json([{ id: 1, name: "Example" }]));
    vi.stubGlobal("fetch", fetchMock);
    const pages = await route(request("/v1/wordpress/pages?per_page=10&unsafe=discarded"), environment());
    expect(pages.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://wordpress.test/wp-json/wp/v2/pages?per_page=10");
    await route(request("/v1/geodirectory/fields?post_type=gd_place"), environment());
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://wordpress.test/wp-json/geodir/v2/fields?post_type=gd_place",
    );
    const write = await route(request("/v1/wordpress/posts", { method: "POST" }), environment());
    expect(write.status).toBe(405);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the authoritative GeoDirectory consumer secret names for Basic authentication", async () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);
    await route(request("/v1/geodirectory/listing-types"), environment());
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Basic ${btoa("consumer-key:consumer-secret")}`,
    );
    expect(Object.keys(environment())).toContain("GEODIRECTORY_CONSUMER_KEY");
    expect(Object.keys(environment())).toContain("GEODIRECTORY_CONSUMER_SECRET");
    expect(environment()).not.toHaveProperty("WORDPRESS_USERNAME");
    expect(environment()).not.toHaveProperty("WORDPRESS_APPLICATION_PASSWORD");
  });

  it.each([
    ["/v1/wordpress/pages", "/wp-json/wp/v2/pages"],
    ["/v1/wordpress/pages/7", "/wp-json/wp/v2/pages/7"],
    ["/v1/wordpress/posts", "/wp-json/wp/v2/posts"],
    ["/v1/wordpress/posts/7", "/wp-json/wp/v2/posts/7"],
    ["/v1/wordpress/categories", "/wp-json/wp/v2/categories"],
    ["/v1/wordpress/categories/7", "/wp-json/wp/v2/categories/7"],
    ["/v1/geodirectory/listing-types", "/wp-json/geodir/v2/types"],
    ["/v1/geodirectory/taxonomies", "/wp-json/geodir/v2/taxonomies"],
    ["/v1/geodirectory/fields", "/wp-json/geodir/v2/fields"],
    ["/v1/geodirectory/settings", "/wp-json/geodir/v2/settings"],
    ["/v1/geodirectory/locations", "/wp-json/geodir/v2/locations"],
    ["/v1/geodirectory/cities", "/wp-json/geodir/v2/locations/cities"],
  ])("preserves GET %s", async (workerPath: string, upstreamPath: string) => {
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);
    expect((await route(request(workerPath), environment())).status).toBe(200);
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe(upstreamPath);
  });

  it("preserves the connection-test response contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
    expect(await payload(await route(request("/v1/connection-test"), environment()))).toEqual({
      database: { connected: true },
      wordpress: { connected: true },
      geodirectory: { connected: true },
    });
  });

  it("returns only connection booleans when connection checks fail", async () => {
    const failedDatabase = environment();
    failedDatabase.DIRECTORY_DB = {
      prepare: () => ({
        first: async () => { throw new Error("database detail must not escape"); },
      }) as unknown as D1PreparedStatement,
    } as D1Database;
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("wordpress detail must not escape"))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await payload(await route(request("/v1/connection-test"), failedDatabase))).toEqual({
      database: { connected: false },
      wordpress: { connected: false },
      geodirectory: { connected: true },
    });
  });

  it("applies CORS only to configured origins", async () => {
    const allowed = await route(request("/v1/capabilities", { headers: { origin: "https://console.test" } }), environment());
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://console.test");
    const denied = await route(request("/v1/capabilities", { headers: { origin: "https://other.test" } }), environment());
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    const wildcardEnv = { ...environment(), ALLOWED_ORIGINS: "*" };
    const wildcard = await route(request("/v1/capabilities", { headers: { origin: "https://other.test" } }), wildcardEnv);
    expect(wildcard.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers preflight without credentials using only the preserved headers", async () => {
    const response = await route(new Request("https://worker.test/v1/database/status", {
      method: "OPTIONS",
      headers: { origin: "https://console.test" },
    }), environment());
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type, x-directory-engine-key, x-request-id",
    );
    const mcp = await route(new Request("https://worker.test/mcp", {
      method: "OPTIONS", headers: { origin: "https://console.test" },
    }), environment());
    expect(mcp.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });

  it("returns or preserves request IDs on every response", async () => {
    const generated = await route(request("/v1/capabilities"), environment());
    expect(generated.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const supplied = await route(request("/v1/capabilities", { headers: { "x-request-id": "caller-id" } }), environment());
    expect(supplied.headers.get("x-request-id")).toBe("caller-id");
  });

  it("requires HTTPS for WordPress and strips out-of-range upstream pagination", async () => {
    const insecure = { ...environment(), WORDPRESS_BASE_URL: "http://wordpress.test" };
    expect((await route(request("/v1/wordpress/pages"), insecure)).status).toBe(500);
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);
    await route(request("/v1/wordpress/pages?per_page=101&page=2"), environment());
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://wordpress.test/wp-json/wp/v2/pages?page=2");
  });

  it("rejects redirects, retries transient failures, and limits upstream bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://other.test" } })));
    let response = await route(request("/v1/wordpress/pages"), environment());
    expect(response.status).toBe(500);
    expect(await payload(response)).toEqual({ error: "Inspection request failed" });

    const retry = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", retry);
    response = await route(request("/v1/wordpress/pages"), environment());
    expect(response.status).toBe(500);
    expect(await payload(response)).toEqual({ error: "Inspection request failed" });
    expect(retry).toHaveBeenCalledTimes(3);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("too large", {
      headers: { "content-length": "1048577" },
    })));
    response = await route(request("/v1/wordpress/pages"), environment());
    expect(response.status).toBe(500);
    expect(await payload(response)).toEqual({ error: "Inspection request failed" });
  });

  it("uses the baseline HTTP 500 contract for WordPress and GeoDirectory failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { code: "upstream_failure", message: "internal upstream detail" },
      { status: 403 },
    )));
    for (const path of ["/v1/wordpress/posts", "/v1/geodirectory/fields"]) {
      const response = await route(request(path), environment());
      expect(response.status).toBe(500);
      expect(await payload(response)).toEqual({ error: "Inspection request failed" });
    }
  });
});

describe("read-only MCP upgrade", () => {
  const call = (method: string, params?: unknown) => route(request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), environment());

  it("requires the same API key as the REST inspection routes", async () => {
    const response = await route(new Request("https://worker.test/mcp", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }), environment());
    expect(response.status).toBe(401);
  });

  it("initializes as the same v0.2.0 Worker", async () => {
    expect(await payload(await call("initialize"))).toMatchObject({
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "directory-engine-api", version: "0.2.0" } },
    });
  });

  it("registers all required inspection tools and marks every tool read-only", async () => {
    const names = MCP_TOOLS.map(({ name }) => name);
    expect(names).toEqual([
      "health_check", "test_connections", "get_database_status", "get_database_schema",
      "list_listing_types", "list_taxonomies", "list_fields", "get_geodirectory_settings",
      "list_locations", "list_cities", "list_wordpress_pages", "list_wordpress_posts",
      "list_wordpress_categories",
    ]);
    expect(MCP_TOOLS.every(({ annotations }) =>
      annotations.readOnlyHint && !annotations.destructiveHint && annotations.idempotentHint,
    )).toBe(true);
  });

  it("calls database inspection through MCP", async () => {
    const body = await payload(await call("tools/call", {
      name: "get_database_status", arguments: {},
    }));
    expect(body.result.structuredContent).toEqual({ connected: true, binding: "DIRECTORY_DB", table_count: 21 });
    expect(body.result.isError).not.toBe(true);
  });

  it("does not expose any write tool", () => {
    expect(MCP_TOOLS.map(({ name }) => name).join(" ")).not.toMatch(/create|update|delete|write|publish|insert/i);
  });
});
