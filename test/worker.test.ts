import { afterEach, describe, expect, it, vi } from "vitest";
import { route } from "../src/index";
import { MCP_TOOLS } from "../src/mcp";
import type { Env } from "../src/types";

function environment(): Env {
  return {
    API_KEY: "test-only-key",
    WORDPRESS_BASE_URL: "https://wordpress.test",
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
  headers.set("x-api-key", "test-only-key");
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
      "https://wordpress.test/wp-json/geodir/v2/custom-fields?post_type=gd_place",
    );
    const write = await route(request("/v1/wordpress/posts", { method: "POST" }), environment());
    expect(write.status).toBe(405);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("applies CORS only to configured origins", async () => {
    const allowed = await route(request("/v1/capabilities", { headers: { origin: "https://console.test" } }), environment());
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://console.test");
    const denied = await route(request("/v1/capabilities", { headers: { origin: "https://other.test" } }), environment());
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
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
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "directory-engine", version: "0.2.0" } },
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
