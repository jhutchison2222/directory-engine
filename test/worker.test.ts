import { afterEach, describe, expect, it, vi } from "vitest";
import { route } from "../src/index";
import { MCP_TOOLS } from "../src/mcp";
import type { Env } from "../src/types";

interface SiteRow {
  id: string;
  site_key: string;
  name: string;
  base_url: string;
  site_role: string;
  archetype_id: string | null;
  wordpress_site_id: string | null;
  status: string;
  timezone: string;
  default_country_code: string;
}

interface ConnectionRow {
  id: string;
  site_id: string;
  provider: string;
  connection_key: string;
  status: string;
  secret_reference: string | null;
  configuration_json: string | null;
  credential_type?: string;
}

interface MasterListingRow {
  id: string;
  name: string;
  category: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  website: string | null;
}

interface PublishQueueRow {
  id: number;
  listing_id: string;
  site_id: string;
  action: string;
}

interface ListingSiteLinkRow {
  listing_id: string;
  site_id: string;
  wp_post_id: number | null;
  publish_status: string;
  last_error: string | null;
  locked?: number;
}

/**
 * A tiny hand-rolled D1 fake. It only understands the exact query shapes
 * this Worker issues (matched by substring, same approach the original
 * mock used for pragma_table_info) -- not a general SQL engine, just
 * enough to exercise the sites/integration_connections/write_audit_log
 * paths added for the multi-site work, on top of the original
 * table_count/schema fixtures every pre-existing test already relied on.
 */
function fakeDirectoryDb(seed: {
  sites?: SiteRow[];
  connections?: ConnectionRow[];
  masterListings?: MasterListingRow[];
  publishQueue?: PublishQueueRow[];
  listingSiteLinks?: ListingSiteLinkRow[];
} = {}): D1Database {
  const sites: SiteRow[] = seed.sites ?? [];
  const connections: ConnectionRow[] = seed.connections ?? [];
  const masterListings: MasterListingRow[] = seed.masterListings ?? [];
  const publishQueue: PublishQueueRow[] = seed.publishQueue ?? [];
  const listingSiteLinks: ListingSiteLinkRow[] = seed.listingSiteLinks ?? [];

  function prepare(sql: string) {
    let params: unknown[] = [];
    return {
      bind(...bound: unknown[]) {
        params = bound;
        return this;
      },
      async first<T>(): Promise<T | null> {
        if (sql.includes("FROM sites") && sql.includes("OR site_key")) {
          const [needle] = params as [string];
          return (sites.find((site) => site.id === needle || site.site_key === needle) ?? null) as T | null;
        }
        if (sql.includes("SELECT id FROM sites WHERE id = ?")) {
          const [id] = params as [string];
          const found = sites.find((site) => site.id === id);
          return (found ? { id: found.id } : null) as T | null;
        }
        if (sql.includes("FROM integration_connections")) {
          const [siteId, credentialType] = params as [string, string | undefined];
          const wantedType = credentialType ?? "geodir_consumer_key";
          const match = connections.find(
            (c) =>
              c.site_id === siteId &&
              c.provider === "wordpress" &&
              (c.credential_type ?? "geodir_consumer_key") === wantedType,
          );
          return (match ?? null) as T | null;
        }
        if (sql.includes("FROM publish_queue")) {
          const [id] = params as [number];
          return (publishQueue.find((entry) => entry.id === id) ?? null) as T | null;
        }
        if (sql.includes("FROM master_listings")) {
          const [id] = params as [string];
          return (masterListings.find((listing) => listing.id === id) ?? null) as T | null;
        }
        if (sql.includes("FROM listing_site_links")) {
          // handleListingWebhook's lookup-by-wp_post_id: WHERE site_id = ? AND wp_post_id = ?
          // (distinct param order/shape from the listing_id + site_id lookup below).
          if (sql.includes("WHERE site_id = ? AND wp_post_id = ?")) {
            const [siteId, wpPostId] = params as [string, number];
            const match = listingSiteLinks.find((link) => link.site_id === siteId && link.wp_post_id === wpPostId);
            return (match ? { listing_id: match.listing_id } : null) as T | null;
          }
          const [listingId, siteId] = params as [string, string];
          const match = listingSiteLinks.find((link) => link.listing_id === listingId && link.site_id === siteId);
          return (match ? { wp_post_id: match.wp_post_id, locked: match.locked ?? 0 } : null) as T | null;
        }
        return { table_count: 21 } as T;
      },
      async all<T>() {
        if (sql.includes("FROM sites") && sql.includes("ORDER BY name")) {
          return { success: true, meta: {}, results: sites as unknown as T[] };
        }
        return {
          success: true,
          meta: {},
          results: (sql.includes("pragma_table_info")
            ? [{ table_name: "wp_posts", cid: 0, column_name: "ID", type: "INTEGER", not_null: 1, default_value: null, primary_key: 1 }]
            : []) as unknown as T[],
        };
      },
      async run() {
        if (sql.includes("INSERT INTO sites")) {
          const [id, site_key, name, base_url, site_role, archetype_id, wordpress_site_id, status, timezone, default_country_code] =
            params as [string, string, string, string, string, string | null, string | null, string, string, string];
          const row: SiteRow = { id, site_key, name, base_url, site_role, archetype_id, wordpress_site_id, status, timezone, default_country_code };
          const index = sites.findIndex((site) => site.id === id);
          if (index >= 0) sites[index] = row;
          else sites.push(row);
        } else if (sql.includes("INSERT INTO integration_connections")) {
          const [id, site_id, provider, connection_key, status, secret_reference, configuration_json] =
            params as [string, string, string, string, string, string | null, string | null];
          const row: ConnectionRow = { id, site_id, provider, connection_key, status, secret_reference, configuration_json };
          const index = connections.findIndex((c) => c.id === id);
          if (index >= 0) connections[index] = row;
          else connections.push(row);
        } else if (sql.includes("INSERT INTO listing_site_links")) {
          if (sql.includes("locked")) {
            // handleListingWebhook's owner-created-listing insert: publish_status
            // and locked are literals in the SQL, not bound params.
            const [listing_id, site_id, wp_post_id] = params as [string, string, number];
            const row: ListingSiteLinkRow = {
              listing_id, site_id, wp_post_id, publish_status: "published", last_error: null, locked: 1,
            };
            const index = listingSiteLinks.findIndex((link) => link.listing_id === listing_id && link.site_id === site_id);
            if (index >= 0) listingSiteLinks[index] = row;
            else listingSiteLinks.push(row);
          } else {
            const [listing_id, site_id, wp_post_id, publish_status, last_error] =
              params as [string, string, number | null, string, string | null];
            const index = listingSiteLinks.findIndex((link) => link.listing_id === listing_id && link.site_id === site_id);
            const row: ListingSiteLinkRow = {
              listing_id, site_id, wp_post_id, publish_status, last_error,
              locked: index >= 0 ? listingSiteLinks[index].locked : 0,
            };
            if (index >= 0) listingSiteLinks[index] = row;
            else listingSiteLinks.push(row);
          }
        } else if (sql.includes("UPDATE listing_site_links SET locked")) {
          const [listing_id, site_id] = params as [string, string];
          const index = listingSiteLinks.findIndex((link) => link.listing_id === listing_id && link.site_id === site_id);
          if (index >= 0) listingSiteLinks[index] = { ...listingSiteLinks[index], locked: 1 };
        } else if (sql.includes("INSERT INTO master_listings") && sql.includes("'owner_created'")) {
          const [id, source_id, name, category, address, city, region, country, lat, lng, phone, website] =
            params as [string, string, string, string | null, string | null, string | null, string | null, string | null, number | null, number | null, string | null, string | null];
          masterListings.push({ id, name, category, address, city, region, country, lat, lng, phone, website });
        } else if (sql.includes("DELETE FROM publish_queue")) {
          const [id] = params as [number];
          const index = publishQueue.findIndex((entry) => entry.id === id);
          if (index >= 0) publishQueue.splice(index, 1);
        }
        // INSERT INTO write_audit_log and every other write in this suite
        // just needs to succeed -- no assertions read it back.
        return { success: true, meta: { last_row_id: 1 }, results: [] };
      },
    } as unknown as D1PreparedStatement;
  }

  return { prepare } as unknown as D1Database;
}

function environment(
  overrides: Partial<Env> = {},
  dbSeed: {
    sites?: SiteRow[];
    connections?: ConnectionRow[];
    masterListings?: MasterListingRow[];
    publishQueue?: PublishQueueRow[];
    listingSiteLinks?: ListingSiteLinkRow[];
  } = {},
): Env {
  return {
    DIRECTORY_ENGINE_API_KEY: "test-only-key",
    DIRECTORY_ENGINE_WRITE_API_KEY: "test-only-write-key",
    WORDPRESS_WEBHOOK_SECRET: "test-only-webhook-secret",
    WORDPRESS_BASE_URL: "https://wordpress.test",
    GEODIRECTORY_CONSUMER_KEY: "consumer-key",
    GEODIRECTORY_CONSUMER_SECRET: "consumer-secret",
    ALLOWED_ORIGINS: "https://console.test",
    DIRECTORY_DB: fakeDirectoryDb(dbSeed),
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-directory-engine-key", "test-only-key");
  return new Request(`https://worker.test${path}`, { ...init, headers });
}

function writeRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-directory-engine-key", "test-only-key");
  headers.set("x-directory-engine-write-key", "test-only-write-key");
  headers.set("content-type", "application/json");
  return new Request(`https://worker.test${path}`, { ...init, headers });
}

// The webhook route is deliberately NOT gated by x-directory-engine-key --
// see security.ts's isWebhookAuthorized() -- so this helper only sets the
// webhook secret, not the read key.
function webhookRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-directory-engine-webhook-secret", "test-only-webhook-secret");
  headers.set("content-type", "application/json");
  return new Request(`https://worker.test${path}`, { ...init, headers });
}

async function payload(response: Response): Promise<any> {
  return response.json();
}

type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

function jsonFetchMock(body: unknown, init?: ResponseInit): FetchMock {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(body, init));
}

afterEach(() => vi.unstubAllGlobals());

describe("deployed v0.4.0 contract (v0.2.0 read-only behavior, preserved)", () => {
  it("keeps health public and protects inspection routes", async () => {
    expect(await payload(await route(new Request("https://worker.test/health"), environment())))
      .toMatchObject({ status: "ok", version: "0.4.0" });
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

  it("advertises the read+write routes, binding, and MCP tools", async () => {
    const response = await route(request("/v1/capabilities"), environment());
    const body = await payload(response);
    expect(body).toMatchObject({ version: "0.4.0", read_only: false, database_binding: "DIRECTORY_DB" });
    expect(body.routes.database).toEqual(["/v1/database/status", "/v1/database/schema"]);
    expect(body.routes.wordpress).toContain("/v1/wordpress/pages");
    expect(body.routes.geodirectory).toContain("/v1/geodirectory/listing-types");
    expect(body.routes.sites_read).toBe("/v1/sites");
    expect(body.routes.write.sites).toBe("POST /v1/write/sites");
    expect(body.routes.mcp).toBe("/mcp");
  });

  it("reports the existing 21-table database without creating a schema", async () => {
    const status = await payload(await route(request("/v1/database/status"), environment()));
    expect(status).toEqual({ connected: true, binding: "DIRECTORY_DB", table_count: 21 });
    const schema = await payload(await route(request("/v1/database/schema"), environment()));
    expect(schema.binding).toBe("DIRECTORY_DB");
    expect(schema.tables.wp_posts[0]).toMatchObject({ column_name: "ID", primary_key: 1 });
  });

  it("proxies only read-only WordPress and GeoDirectory GET routes, falling back to the legacy single site", async () => {
    const fetchMock = jsonFetchMock([{ id: 1, name: "Example" }]);
    vi.stubGlobal("fetch", fetchMock);
    const pages = await route(request("/v1/wordpress/pages?per_page=10&unsafe=discarded"), environment());
    expect(pages.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://wordpress.test/wp-json/wp/v2/pages?per_page=10");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe(
      `Basic ${btoa("consumer-key:consumer-secret")}`,
    );
    await route(request("/v1/geodirectory/fields?post_type=gd_place"), environment());
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://wordpress.test/wp-json/geodir/v2/fields?post_type=gd_place",
    );
    const write = await route(request("/v1/wordpress/posts", { method: "POST" }), environment());
    expect(write.status).toBe(405);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    const fetchMock = jsonFetchMock([]);
    vi.stubGlobal("fetch", fetchMock);
    expect((await route(request(workerPath), environment())).status).toBe(200);
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe(upstreamPath);
  });

  it("preserves the connection-test response contract (plus the new site_id field)", async () => {
    vi.stubGlobal("fetch", jsonFetchMock({ ok: true }));
    expect(await payload(await route(request("/v1/connection-test"), environment()))).toEqual({
      database: { connected: true },
      wordpress: { connected: true },
      geodirectory: { connected: true },
      site_id: null,
    });
  });

  it("returns only connection booleans when connection checks fail", async () => {
    const failedDatabase = environment();
    failedDatabase.DIRECTORY_DB = {
      prepare: () => ({
        first: async () => { throw new Error("database detail must not escape"); },
      }),
    } as unknown as D1Database;
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new Error("wordpress detail must not escape"))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await payload(await route(request("/v1/connection-test"), failedDatabase))).toEqual({
      database: { connected: false },
      wordpress: { connected: false },
      geodirectory: { connected: true },
      site_id: null,
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

  it("answers preflight without credentials using the write-aware header set", async () => {
    const response = await route(new Request("https://worker.test/v1/database/status", {
      method: "OPTIONS",
      headers: { origin: "https://console.test" },
    }), environment());
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type, x-directory-engine-key, x-directory-engine-write-key, x-directory-engine-actor, x-request-id",
    );
    const mcp = await route(new Request("https://worker.test/mcp", {
      method: "OPTIONS", headers: { origin: "https://console.test" },
    }), environment());
    expect(mcp.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    const write = await route(new Request("https://worker.test/v1/write/sites", {
      method: "OPTIONS", headers: { origin: "https://console.test" },
    }), environment());
    expect(write.headers.get("access-control-allow-methods")).toBe("POST, PUT, DELETE, OPTIONS");
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
    const fetchMock = jsonFetchMock([]);
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
    vi.stubGlobal("fetch", jsonFetchMock(
      { code: "upstream_failure", message: "internal upstream detail" },
      { status: 403 },
    ));
    for (const path of ["/v1/wordpress/posts", "/v1/geodirectory/fields"]) {
      const response = await route(request(path), environment());
      expect(response.status).toBe(500);
      expect(await payload(response)).toEqual({ error: "Inspection request failed" });
    }
  });
});

describe("multi-site connection resolution", () => {
  const restaurantsSite: SiteRow = {
    id: "restaurants", site_key: "restaurants", name: "Restaurants",
    base_url: "https://restaurants.directory-engine.net", site_role: "niche_template",
    archetype_id: null, wordpress_site_id: null, status: "staging",
    timezone: "America/Denver", default_country_code: "US",
  };

  it("lists registered sites via REST and MCP", async () => {
    const env = environment({}, { sites: [restaurantsSite] });
    const rest = await payload(await route(request("/v1/sites"), env));
    expect(rest.items).toHaveLength(1);
    expect(rest.items[0]).toMatchObject({ id: "restaurants", base_url: restaurantsSite.base_url });

    const mcpResponse = await payload(await route(request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sites", arguments: {} } }),
    }), env));
    expect(mcpResponse.result.structuredContent.items).toHaveLength(1);
  });

  it("routes a WordPress read to a specific site's base_url and its active connection's credentials", async () => {
    const env = environment({}, {
      sites: [restaurantsSite],
      connections: [{
        id: "restaurants-wordpress", site_id: "restaurants", provider: "wordpress",
        connection_key: "restaurants-wp-geodirectory", status: "active",
        secret_reference: "WP_CREDENTIALS_RESTAURANTS", configuration_json: null,
      }],
    });
    env.WP_CREDENTIALS_RESTAURANTS = JSON.stringify({ consumerKey: "site-key", consumerSecret: "site-secret" });
    const fetchMock = jsonFetchMock([]);
    vi.stubGlobal("fetch", fetchMock);

    const response = await route(request("/v1/wordpress/pages?site_id=restaurants"), env);
    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://restaurants.directory-engine.net/wp-json/wp/v2/pages");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe(
      `Basic ${btoa("site-key:site-secret")}`,
    );
  });

  it("omits auth for a site with no active connection yet, rather than reusing the legacy credentials", async () => {
    const env = environment({}, { sites: [restaurantsSite] }); // no integration_connections row at all
    const fetchMock = jsonFetchMock([]);
    vi.stubGlobal("fetch", fetchMock);

    const response = await route(request("/v1/wordpress/pages?site_id=restaurants"), env);
    expect(response.status).toBe(200);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBeNull();
  });

  it("fails clearly, without leaking detail, for an unregistered site_id", async () => {
    const env = environment();
    const response = await route(request("/v1/wordpress/pages?site_id=does-not-exist"), env);
    expect(response.status).toBe(500);
    expect(await payload(response)).toEqual({ error: "Inspection request failed" });
  });

  it("reports the resolved site_id from test_connections when one is given", async () => {
    vi.stubGlobal("fetch", jsonFetchMock({ ok: true }));
    const env = environment({}, { sites: [restaurantsSite] });
    const body = await payload(await route(request("/v1/connection-test?site_id=restaurants"), env));
    expect(body.site_id).toBe("restaurants");
  });
});

describe("write layer (restored from the live v0.3.0 deploy, plus the new site tools)", () => {
  it("rejects writes with a valid read key but no write key, and with the wrong write key", async () => {
    const env = environment();
    const noWriteKey = await route(request("/v1/write/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site_key: "hvac", name: "HVAC", base_url: "https://hvac.directory-engine.net" }),
    }), env);
    expect(noWriteKey.status).toBe(403);

    const wrongWriteKey = await route(new Request("https://worker.test/v1/write/sites", {
      method: "POST",
      headers: {
        "x-directory-engine-key": "test-only-key",
        "x-directory-engine-write-key": "wrong-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ site_key: "hvac", name: "HVAC", base_url: "https://hvac.directory-engine.net" }),
    }), env);
    expect(wrongWriteKey.status).toBe(403);
  });

  it("creates a site via REST and it's immediately visible via list_sites", async () => {
    const env = environment();
    const created = await payload(await route(writeRequest("/v1/write/sites", {
      method: "POST",
      body: JSON.stringify({
        site_key: "hvac", name: "HVAC", base_url: "https://hvac.directory-engine.net",
        site_role: "niche_template", status: "staging",
      }),
    }), env));
    expect(created).toMatchObject({ id: "hvac", site_key: "hvac", site_role: "niche_template", status: "staging" });

    const listed = await payload(await route(request("/v1/sites"), env));
    expect(listed.items.map((site: SiteRow) => site.id)).toEqual(["hvac"]);
  });

  it("rejects an insecure or invalid site_role on upsert_site", async () => {
    const env = environment();
    const insecure = await route(writeRequest("/v1/write/sites", {
      method: "POST",
      body: JSON.stringify({ site_key: "hvac", name: "HVAC", base_url: "http://hvac.directory-engine.net" }),
    }), env);
    expect(insecure.status).toBe(400);

    const badRole = await route(writeRequest("/v1/write/sites", {
      method: "POST",
      body: JSON.stringify({
        site_key: "hvac", name: "HVAC", base_url: "https://hvac.directory-engine.net", site_role: "not-a-real-role",
      }),
    }), env);
    expect(badRole.status).toBe(400);
  });

  it("registers an integration connection for an existing site via MCP, and rejects an unknown site", async () => {
    const env = environment({}, {
      sites: [{
        id: "hvac", site_key: "hvac", name: "HVAC", base_url: "https://hvac.directory-engine.net",
        site_role: "niche_template", archetype_id: null, wordpress_site_id: null, status: "staging",
        timezone: "America/Denver", default_country_code: "US",
      }],
    });
    const call = (arguments_: unknown) => route(new Request("https://worker.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-directory-engine-key": "test-only-key",
        "x-directory-engine-write-key": "test-only-write-key",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "upsert_integration_connection", arguments: arguments_ } }),
    }), env);

    const ok = await payload(await call({
      site_id: "hvac", provider: "wordpress", connection_key: "hvac-wp-geodirectory",
      status: "inactive", secret_reference: "WP_CREDENTIALS_HVAC",
    }));
    expect(ok.result.structuredContent).toMatchObject({ site_id: "hvac", status: "inactive" });

    const unknownSite = await payload(await call({
      site_id: "does-not-exist", provider: "wordpress", connection_key: "x",
    }));
    expect(unknownSite.result.isError).toBe(true);
    expect(unknownSite.result.content[0].text).toMatch(/Unknown site_id/);
  });

  it("keeps the deprecated upsert_site_profile route working", async () => {
    const env = environment();
    const response = await route(writeRequest("/v1/write/site-profiles", {
      method: "POST",
      body: JSON.stringify({ domain: "hvac.directory-engine.net", niche: "hvac", scope_level: "metro", scope_value: "Denver Metro" }),
    }), env);
    expect(response.status).toBe(200);
    expect(await payload(response)).toMatchObject({ domain: "hvac.directory-engine.net", niche: "hvac" });
  });

  function withActiveRestaurantsConnection(): Env {
    const env = environment({}, {
      sites: [{
        id: "restaurants", site_key: "restaurants", name: "Restaurants",
        base_url: "https://restaurants.directory-engine.net", site_role: "niche_template",
        archetype_id: null, wordpress_site_id: null, status: "staging",
        timezone: "America/Denver", default_country_code: "US",
      }],
      connections: [{
        id: "restaurants-wordpress", site_id: "restaurants", provider: "wordpress",
        connection_key: "restaurants-wp-geodirectory", status: "active",
        secret_reference: "WP_CREDENTIALS_RESTAURANTS", configuration_json: null,
      }],
    });
    env.WP_CREDENTIALS_RESTAURANTS = JSON.stringify({ consumerKey: "site-key", consumerSecret: "site-secret" });
    return env;
  }

  it("creates a GeoDirectory category on a specific site by proxying to its own geodir/v2 REST API", async () => {
    const env = withActiveRestaurantsConnection();
    const fetchMock = jsonFetchMock({ id: 42, name: "Pizza", parent: 7 });
    vi.stubGlobal("fetch", fetchMock);

    const response = await route(writeRequest("/v1/write/geodir-categories", {
      method: "POST",
      body: JSON.stringify({ site_id: "restaurants", name: "Pizza", parent: 7 }),
    }), env);
    expect(response.status).toBe(200);
    expect(await payload(response)).toMatchObject({ id: 42, name: "Pizza", parent: 7 });

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://restaurants.directory-engine.net/wp-json/geodir/v2/places/categories",
    );
    const init = fetchMock.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${btoa("site-key:site-secret")}`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ name: "Pizza", parent: 7 });
  });

  it("updates an existing GeoDirectory category by id instead of creating a new one", async () => {
    const env = withActiveRestaurantsConnection();
    const fetchMock = jsonFetchMock({ id: 42, name: "Pizza & Italian" });
    vi.stubGlobal("fetch", fetchMock);

    await route(writeRequest("/v1/write/geodir-categories/42", {
      method: "PUT",
      body: JSON.stringify({ site_id: "restaurants", name: "Pizza & Italian" }),
    }), env);

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://restaurants.directory-engine.net/wp-json/geodir/v2/places/categories/42",
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe("PUT");
  });

  it("creates a GeoDirectory tag via MCP", async () => {
    const env = withActiveRestaurantsConnection();
    const fetchMock = jsonFetchMock({ id: 5, name: "Gluten-Free" });
    vi.stubGlobal("fetch", fetchMock);

    const call = (arguments_: unknown) => route(new Request("https://worker.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-directory-engine-key": "test-only-key",
        "x-directory-engine-write-key": "test-only-write-key",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "upsert_geodir_tag", arguments: arguments_ } }),
    }), env);

    const response = await payload(await call({ site_id: "restaurants", name: "Gluten-Free" }));
    expect(response.result.structuredContent).toMatchObject({ id: 5, name: "Gluten-Free" });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://restaurants.directory-engine.net/wp-json/geodir/v2/places/tags",
    );
  });

  it("updates a single GeoDirectory setting by group_id and id", async () => {
    const env = withActiveRestaurantsConnection();
    const fetchMock = jsonFetchMock({ id: "maps_api_key", value: "abc123" });
    vi.stubGlobal("fetch", fetchMock);

    const response = await route(writeRequest("/v1/write/geodir-settings/maps", {
      method: "PUT",
      body: JSON.stringify({ site_id: "restaurants", id: "maps_api_key", value: "abc123" }),
    }), env);
    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://restaurants.directory-engine.net/wp-json/geodir/v2/settings/maps",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ id: "maps_api_key", value: "abc123" });
  });

  it("rejects a geodir-settings update with no value", async () => {
    const env = withActiveRestaurantsConnection();
    const response = await route(writeRequest("/v1/write/geodir-settings/maps", {
      method: "PUT",
      body: JSON.stringify({ site_id: "restaurants", id: "maps_api_key" }),
    }), env);
    expect(response.status).toBe(400);
  });
});

describe("publish queue processor", () => {
  function withPublishReadyRestaurantsConnection(listingSiteLinks: ListingSiteLinkRow[] = []): Env {
    const env = environment({}, {
      sites: [{
        id: "restaurants", site_key: "restaurants", name: "Restaurants",
        base_url: "https://restaurants.directory-engine.net", site_role: "niche_template",
        archetype_id: null, wordpress_site_id: null, status: "staging",
        timezone: "America/Denver", default_country_code: "US",
      }],
      connections: [
        {
          id: "restaurants-wordpress", site_id: "restaurants", provider: "wordpress",
          connection_key: "restaurants-wp-geodirectory", status: "active",
          secret_reference: "WP_CREDENTIALS_RESTAURANTS", configuration_json: null,
          credential_type: "geodir_consumer_key",
        },
        {
          id: "restaurants-wordpress-app-password", site_id: "restaurants", provider: "wordpress",
          connection_key: "restaurants-wp-app-password", status: "active",
          secret_reference: "WP_APP_PASSWORD_RESTAURANTS", configuration_json: null,
          credential_type: "wp_application_password",
        },
      ],
      masterListings: [{
        id: "listing-1", name: "Tony's Pizza", category: "Pizza",
        address: "123 Main St", city: "Denver", region: "CO", country: "US",
        lat: 39.7, lng: -104.9, phone: "555-1234", website: "https://tonyspizza.example",
      }],
      publishQueue: [{ id: 1, listing_id: "listing-1", site_id: "restaurants", action: "publish" }],
      listingSiteLinks,
    });
    env.WP_CREDENTIALS_RESTAURANTS = JSON.stringify({ consumerKey: "site-key", consumerSecret: "site-secret" });
    env.WP_APP_PASSWORD_RESTAURANTS = JSON.stringify({ username: "firm777", applicationPassword: "abcd 1234 efgh 5678" });
    return env;
  }

  it("publishes a new listing, auto-creating its category with the consumer key, then creates the WP post with the application password", async () => {
    const env = withPublishReadyRestaurantsConnection();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json([{ id: 7, name: "Tacos" }])) // GET categories -- no "Pizza" match yet
      .mockResolvedValueOnce(Response.json({ id: 42, name: "Pizza" })) // POST create category
      .mockResolvedValueOnce(Response.json({ id: 501, title: "Tony's Pizza" })); // POST places
    vi.stubGlobal("fetch", fetchMock);

    const response = await route(
      writeRequest("/v1/write/publish-queue/1/process", { method: "POST", body: "{}" }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await payload(response)).toMatchObject({
      id: 1, listing_id: "listing-1", site_id: "restaurants", action: "publish",
      wp_post_id: 501, publish_status: "published",
    });

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://restaurants.directory-engine.net/wp-json/geodir/v2/places/categories?per_page=100",
    );
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe(
      `Basic ${btoa("site-key:site-secret")}`,
    );

    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://restaurants.directory-engine.net/wp-json/geodir/v2/places/categories",
    );
    expect(fetchMock.mock.calls[1][1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ name: "Pizza" });

    expect(String(fetchMock.mock.calls[2][0])).toBe(
      "https://restaurants.directory-engine.net/wp-json/geodir/v2/places",
    );
    expect(fetchMock.mock.calls[2][1]?.method).toBe("POST");
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("authorization")).toBe(
      `Basic ${btoa("firm777:abcd 1234 efgh 5678")}`,
    );
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      title: "Tony's Pizza", status: "draft", post_category: [42],
      street: "123 Main St", city: "Denver", region: "CO", country: "US",
      latitude: "39.7", longitude: "-104.9", phone: "555-1234", website: "https://tonyspizza.example",
    });

    // The queue entry is gone either way -- re-processing the same id now fails clearly.
    const reprocessed = await route(
      writeRequest("/v1/write/publish-queue/1/process", { method: "POST", body: "{}" }),
      env,
    );
    expect(reprocessed.status).toBe(400);
    expect(await payload(reprocessed)).toEqual({ error: "Unknown publish_queue id: 1" });
  });

  it("records a failed listing_site_links row and removes the queue entry when no application password is registered", async () => {
    const env = environment({}, {
      sites: [{
        id: "restaurants", site_key: "restaurants", name: "Restaurants",
        base_url: "https://restaurants.directory-engine.net", site_role: "niche_template",
        archetype_id: null, wordpress_site_id: null, status: "staging",
        timezone: "America/Denver", default_country_code: "US",
      }],
      connections: [],
      masterListings: [{
        id: "listing-2", name: "Sunset Diner", category: "Diner",
        address: null, city: null, region: null, country: null,
        lat: null, lng: null, phone: null, website: null,
      }],
      publishQueue: [{ id: 2, listing_id: "listing-2", site_id: "restaurants", action: "publish" }],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await route(
      writeRequest("/v1/write/publish-queue/2/process", { method: "POST", body: "{}" }),
      env,
    );
    expect(response.status).toBe(500);
    expect(await payload(response)).toEqual({
      error: "Publish failed for queue id 2, site restaurants: No active wp_application_password credential registered for site restaurants",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // Failed attempts are removed from the queue too -- there is no retry queue yet.
    const reprocessed = await route(
      writeRequest("/v1/write/publish-queue/2/process", { method: "POST", body: "{}" }),
      env,
    );
    expect(reprocessed.status).toBe(400);
    expect(await payload(reprocessed)).toEqual({ error: "Unknown publish_queue id: 2" });
  });

  it("rejects an invalid wp_status", async () => {
    const env = withPublishReadyRestaurantsConnection();
    const response = await route(
      writeRequest("/v1/write/publish-queue/1/process", {
        method: "POST",
        body: JSON.stringify({ wp_status: "archived" }),
      }),
      env,
    );
    expect(response.status).toBe(400);
  });

  it("skips a locked (owner-managed) listing without writing to WordPress, but still clears the queue entry", async () => {
    const env = withPublishReadyRestaurantsConnection([
      { listing_id: "listing-1", site_id: "restaurants", wp_post_id: 501, publish_status: "published", last_error: null, locked: 1 },
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await route(
      writeRequest("/v1/write/publish-queue/1/process", { method: "POST", body: "{}" }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await payload(response)).toMatchObject({
      id: 1, listing_id: "listing-1", site_id: "restaurants", action: "publish", skipped: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // The queue entry is gone even though the write was skipped.
    const reprocessed = await route(
      writeRequest("/v1/write/publish-queue/1/process", { method: "POST", body: "{}" }),
      env,
    );
    expect(reprocessed.status).toBe(400);
  });
});

describe("listing webhook (owner-edit safeguard)", () => {
  function withRestaurantsSite(listingSiteLinks: ListingSiteLinkRow[] = []): Env {
    return environment({}, {
      sites: [{
        id: "restaurants", site_key: "restaurants", name: "Restaurants",
        base_url: "https://restaurants.directory-engine.net", site_role: "niche_template",
        archetype_id: null, wordpress_site_id: null, status: "staging",
        timezone: "America/Denver", default_country_code: "US",
      }],
      listingSiteLinks,
    });
  }

  it("rejects a call without the webhook secret, even with a valid read/write key", async () => {
    const env = withRestaurantsSite();
    const response = await route(
      writeRequest("/v1/webhook/listing-changed", {
        method: "POST",
        body: JSON.stringify({ site_id: "restaurants", wp_post_id: 501 }),
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("locks an existing tracked listing when its wp_post_id is already known", async () => {
    const env = withRestaurantsSite([
      { listing_id: "listing-1", site_id: "restaurants", wp_post_id: 501, publish_status: "published", last_error: null, locked: 0 },
    ]);
    const response = await route(
      webhookRequest("/v1/webhook/listing-changed", {
        method: "POST",
        body: JSON.stringify({ site_id: "restaurants", wp_post_id: 501, title: "Tony's Pizza (owner edit)" }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({
      listing_id: "listing-1", site_id: "restaurants", wp_post_id: 501, locked: true, created_new: false,
    });

    // The underlying link is now locked -- processPublishQueueEntry's own
    // locked-skip behavior against this exact row is covered separately
    // above ("skips a locked (owner-managed) listing...").
    const relocked = await env.DIRECTORY_DB.prepare(
      "SELECT wp_post_id, locked FROM listing_site_links WHERE listing_id = ? AND site_id = ?",
    ).bind("listing-1", "restaurants").first<{ locked: number }>();
    expect(relocked?.locked).toBe(1);
  });

  it("creates a new owner-managed master_listings row and a pre-locked link when wp_post_id is unknown", async () => {
    const env = withRestaurantsSite();
    const response = await route(
      webhookRequest("/v1/webhook/listing-changed", {
        method: "POST",
        body: JSON.stringify({
          site_id: "restaurants", wp_post_id: 999, title: "Maria's Tacos",
          category: "Tacos", city: "Denver", region: "CO", country: "US",
          lat: 39.71, lng: -104.95, phone: "555-9999",
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const body = await payload(response);
    expect(body).toMatchObject({ site_id: "restaurants", wp_post_id: 999, locked: true, created_new: true });
    expect(typeof body.listing_id).toBe("string");

    const link = await env.DIRECTORY_DB.prepare(
      "SELECT wp_post_id, locked FROM listing_site_links WHERE listing_id = ? AND site_id = ?",
    ).bind(body.listing_id, "restaurants").first<{ wp_post_id: number; locked: number }>();
    expect(link).toMatchObject({ wp_post_id: 999, locked: 1 });
  });

  it("rejects a webhook call missing wp_post_id or with an unknown site_id", async () => {
    const env = withRestaurantsSite();
    const missingPostId = await route(
      webhookRequest("/v1/webhook/listing-changed", { method: "POST", body: JSON.stringify({ site_id: "restaurants" }) }),
      env,
    );
    expect(missingPostId.status).toBe(400);

    const unknownSite = await route(
      webhookRequest("/v1/webhook/listing-changed", {
        method: "POST",
        body: JSON.stringify({ site_id: "does-not-exist", wp_post_id: 1 }),
      }),
      env,
    );
    expect(unknownSite.status).toBe(400);
  });
});

describe("MCP contract", () => {
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

  it("initializes as the v0.4.0 Worker", async () => {
    expect(await payload(await call("initialize"))).toMatchObject({
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "directory-engine-api", version: "0.4.0" } },
    });
  });

  it("registers every read and write tool, correctly annotated as read-only or not", async () => {
    const names = MCP_TOOLS.map(({ name }) => name);
    expect(names).toEqual([
      "health_check", "test_connections", "get_database_status", "get_database_schema", "list_sites",
      "list_listing_types", "list_taxonomies", "list_fields", "get_geodirectory_settings",
      "list_locations", "list_cities", "list_wordpress_pages", "list_wordpress_posts",
      "list_wordpress_categories",
      "upsert_site_profile", "upsert_site", "upsert_integration_connection", "upsert_master_listing",
      "upsert_listing_site_link", "enqueue_publish", "dequeue_publish",
      "upsert_geodir_category", "upsert_geodir_tag", "update_geodir_settings", "process_publish_queue_entry",
    ]);
    const writeNames = new Set([
      "upsert_site_profile", "upsert_site", "upsert_integration_connection", "upsert_master_listing",
      "upsert_listing_site_link", "enqueue_publish", "dequeue_publish",
      "upsert_geodir_category", "upsert_geodir_tag", "update_geodir_settings", "process_publish_queue_entry",
    ]);
    for (const toolDef of MCP_TOOLS) {
      if (writeNames.has(toolDef.name)) {
        expect(toolDef.annotations.readOnlyHint).toBe(false);
      } else {
        expect(toolDef.annotations.readOnlyHint).toBe(true);
        expect(toolDef.annotations.destructiveHint).toBe(false);
      }
    }
  });

  it("calls database inspection through MCP", async () => {
    const body = await payload(await call("tools/call", {
      name: "get_database_status", arguments: {},
    }));
    expect(body.result.structuredContent).toEqual({ connected: true, binding: "DIRECTORY_DB", table_count: 21 });
    expect(body.result.isError).not.toBe(true);
  });

  it("refuses a write tool call without a write key even with a valid read key", async () => {
    const body = await payload(await call("tools/call", {
      name: "upsert_site", arguments: { site_key: "hvac", name: "HVAC", base_url: "https://hvac.directory-engine.net" },
    }));
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/write-key/i);
  });
});
