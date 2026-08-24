import {
  geodirCategoriesPath,
  geodirSettingsPath,
  geodirTagsPath,
  resolveSiteConnection,
  wordpressWrite,
} from "./inspection";
import type { Env } from "./types";

export class ValidationError extends Error {}

interface StringOptions {
  maxLength?: number;
}

function requireString(value: unknown, field: string, { maxLength = 500 }: StringOptions = {}): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${field} is required`);
  if (value.length > maxLength) throw new ValidationError(`${field} is too long`);
  return value.trim();
}

function optionalString(value: unknown, field: string, { maxLength = 500 }: StringOptions = {}): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
  if (value.length > maxLength) throw new ValidationError(`${field} is too long`);
  return value;
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(`${field} must be a number`);
  return value;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function actorFrom(request: Request): string {
  return request.headers.get("x-directory-engine-actor")?.slice(0, 200) || "unknown";
}

async function logAudit(
  env: Env,
  entry: { action: string; site_id?: string | null; listing_id?: string | null; actor?: string | null; detail?: unknown },
): Promise<void> {
  await env.DIRECTORY_DB.prepare(
    `INSERT INTO write_audit_log (action, site_id, listing_id, actor, detail) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      entry.action,
      entry.site_id ?? null,
      entry.listing_id ?? null,
      entry.actor ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
    )
    .run();
}

const SITE_PROFILE_STATUSES = new Set(["staging", "active", "paused", "retired"]);
// site_role vocabulary matches the four-tier model in architecture-overview.md.
const SITE_ROLES = new Set(["master", "niche_template", "end_site"]);
const SITE_STATUSES = new Set(["draft", "staging", "active", "paused", "retired"]);
const CONNECTION_PROVIDERS = new Set(["wordpress", "geodirectory"]);
const CONNECTION_STATUSES = new Set(["inactive", "active", "error"]);
const MASTER_LISTING_STATUSES = new Set(["pending_review", "approved", "rejected", "archived"]);
const PUBLISH_STATUSES = new Set(["queued", "published", "failed", "unpublished"]);
const PUBLISH_ACTIONS = new Set(["publish", "update", "unpublish"]);

export async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new ValidationError("Content-Type must be application/json");
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new ValidationError("Invalid JSON body");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("Body must be a JSON object");
  }
  return payload as Record<string, unknown>;
}

// DEPRECATED -- kept working for backward compatibility only. See
// worker-multisite-scoping.md for why `sites` (below) replaces this table.
// Do not build anything new against site_profiles.
export async function upsertSiteProfile(env: Env, request: Request, input: Record<string, unknown>) {
  const domain = requireString(input.domain, "domain", { maxLength: 255 }).toLowerCase();
  const niche = requireString(input.niche, "niche", { maxLength: 120 });
  const scope_level = requireString(input.scope_level, "scope_level", { maxLength: 40 });
  const scope_value = requireString(input.scope_value, "scope_value", { maxLength: 200 });
  const url_depth = optionalString(input.url_depth, "url_depth", { maxLength: 40 }) ?? "city";
  const wp_listing_path = optionalString(input.wp_listing_path, "wp_listing_path", { maxLength: 255 });
  const status = optionalString(input.status, "status", { maxLength: 40 }) ?? "staging";
  if (!SITE_PROFILE_STATUSES.has(status)) {
    throw new ValidationError(`status must be one of ${[...SITE_PROFILE_STATUSES].join(", ")}`);
  }
  const id = optionalString(input.id, "id", { maxLength: 100 }) ?? slugify(domain);

  await env.DIRECTORY_DB.prepare(
    `INSERT INTO site_profiles (id, domain, niche, scope_level, scope_value, url_depth, wp_listing_path, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       domain = excluded.domain, niche = excluded.niche, scope_level = excluded.scope_level,
       scope_value = excluded.scope_value, url_depth = excluded.url_depth,
       wp_listing_path = excluded.wp_listing_path, status = excluded.status`,
  )
    .bind(id, domain, niche, scope_level, scope_value, url_depth, wp_listing_path, status)
    .run();

  await logAudit(env, {
    action: "upsert_site_profile",
    site_id: id,
    actor: actorFrom(request),
    detail: { domain, status },
  });
  return { id, domain, niche, scope_level, scope_value, url_depth, wp_listing_path, status };
}

// sites -- the real, forward-looking site registry. FK target for
// listing_site_links and publish_queue (was true even before this change).
export async function upsertSite(env: Env, request: Request, input: Record<string, unknown>) {
  const site_key = requireString(input.site_key, "site_key", { maxLength: 80 }).toLowerCase();
  const name = requireString(input.name, "name", { maxLength: 200 });
  const base_url = requireString(input.base_url, "base_url", { maxLength: 255 });

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(base_url);
  } catch {
    throw new ValidationError("base_url must be a valid URL");
  }
  if (parsedBaseUrl.protocol !== "https:") throw new ValidationError("base_url must use HTTPS");

  const site_role = optionalString(input.site_role, "site_role", { maxLength: 40 }) ?? "end_site";
  if (!SITE_ROLES.has(site_role)) throw new ValidationError(`site_role must be one of ${[...SITE_ROLES].join(", ")}`);

  const archetype_id = optionalString(input.archetype_id, "archetype_id", { maxLength: 100 });
  const wordpress_site_id = optionalString(input.wordpress_site_id, "wordpress_site_id", { maxLength: 100 });

  const status = optionalString(input.status, "status", { maxLength: 40 }) ?? "draft";
  if (!SITE_STATUSES.has(status)) throw new ValidationError(`status must be one of ${[...SITE_STATUSES].join(", ")}`);

  const timezone = optionalString(input.timezone, "timezone", { maxLength: 60 }) ?? "America/Denver";
  const default_country_code =
    optionalString(input.default_country_code, "default_country_code", { maxLength: 10 }) ?? "US";
  const id = optionalString(input.id, "id", { maxLength: 100 }) ?? slugify(site_key);

  await env.DIRECTORY_DB.prepare(
    `INSERT INTO sites (id, site_key, name, base_url, site_role, archetype_id, wordpress_site_id, status, timezone, default_country_code, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       site_key = excluded.site_key, name = excluded.name, base_url = excluded.base_url,
       site_role = excluded.site_role, archetype_id = excluded.archetype_id,
       wordpress_site_id = excluded.wordpress_site_id, status = excluded.status,
       timezone = excluded.timezone, default_country_code = excluded.default_country_code,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(id, site_key, name, base_url, site_role, archetype_id, wordpress_site_id, status, timezone, default_country_code)
    .run();

  await logAudit(env, {
    action: "upsert_site",
    site_id: id,
    actor: actorFrom(request),
    detail: { site_key, base_url, site_role, status },
  });
  return { id, site_key, name, base_url, site_role, archetype_id, wordpress_site_id, status, timezone, default_country_code };
}

// integration_connections -- per-site credential *pointers*. The actual
// secret value never passes through this table or this codebase; only a
// Worker/Secrets Store binding name (secret_reference) does. See
// resolveSiteConnection() in inspection.ts for how it's consumed.
export async function upsertIntegrationConnection(env: Env, request: Request, input: Record<string, unknown>) {
  const site_id = requireString(input.site_id, "site_id", { maxLength: 100 });
  const provider = requireString(input.provider, "provider", { maxLength: 40 });
  if (!CONNECTION_PROVIDERS.has(provider)) {
    throw new ValidationError(`provider must be one of ${[...CONNECTION_PROVIDERS].join(", ")}`);
  }
  const connection_key = requireString(input.connection_key, "connection_key", { maxLength: 200 });

  const status = optionalString(input.status, "status", { maxLength: 40 }) ?? "inactive";
  if (!CONNECTION_STATUSES.has(status)) {
    throw new ValidationError(`status must be one of ${[...CONNECTION_STATUSES].join(", ")}`);
  }

  const secret_reference = optionalString(input.secret_reference, "secret_reference", { maxLength: 200 });
  const configuration_json =
    input.configuration_json === undefined || input.configuration_json === null
      ? null
      : JSON.stringify(input.configuration_json);

  const site = await env.DIRECTORY_DB.prepare(`SELECT id FROM sites WHERE id = ?`).bind(site_id).first();
  if (!site) throw new ValidationError(`Unknown site_id: ${site_id}`);

  const id = optionalString(input.id, "id", { maxLength: 100 }) ?? `${slugify(site_id)}-${provider}`;
  await env.DIRECTORY_DB.prepare(
    `INSERT INTO integration_connections (id, site_id, provider, connection_key, status, secret_reference, configuration_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       site_id = excluded.site_id, provider = excluded.provider, connection_key = excluded.connection_key,
       status = excluded.status, secret_reference = excluded.secret_reference,
       configuration_json = excluded.configuration_json, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(id, site_id, provider, connection_key, status, secret_reference, configuration_json)
    .run();

  await logAudit(env, {
    action: "upsert_integration_connection",
    site_id,
    actor: actorFrom(request),
    detail: { provider, status, secret_reference },
  });
  return { id, site_id, provider, connection_key, status, secret_reference };
}

export async function upsertMasterListing(env: Env, request: Request, input: Record<string, unknown>) {
  const source = requireString(input.source, "source", { maxLength: 60 });
  const name = requireString(input.name, "name", { maxLength: 255 });
  const source_id = optionalString(input.source_id, "source_id", { maxLength: 255 });
  const category = optionalString(input.category, "category", { maxLength: 120 });
  let subcategories: string | null = null;
  if (input.subcategories !== undefined && input.subcategories !== null) {
    if (!Array.isArray(input.subcategories)) throw new ValidationError("subcategories must be an array");
    subcategories = JSON.stringify(input.subcategories);
  }
  const address = optionalString(input.address, "address", { maxLength: 255 });
  const city = optionalString(input.city, "city", { maxLength: 120 });
  const region = optionalString(input.region, "region", { maxLength: 120 });
  const country = optionalString(input.country, "country", { maxLength: 120 }) ?? "United States";
  const lat = optionalNumber(input.lat, "lat");
  const lng = optionalNumber(input.lng, "lng");
  if (lat !== null && (lat < -90 || lat > 90)) throw new ValidationError("lat must be between -90 and 90");
  if (lng !== null && (lng < -180 || lng > 180)) throw new ValidationError("lng must be between -180 and 180");
  const phone = optionalString(input.phone, "phone", { maxLength: 40 });
  const website = optionalString(input.website, "website", { maxLength: 500 });
  if (website) {
    let parsed: URL;
    try {
      parsed = new URL(website);
    } catch {
      throw new ValidationError("website must be a valid URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ValidationError("website must use http or https");
    }
  }
  const attributes = input.attributes === undefined ? null : JSON.stringify(input.attributes);
  const status = optionalString(input.status, "status", { maxLength: 40 }) ?? "pending_review";
  if (!MASTER_LISTING_STATUSES.has(status)) {
    throw new ValidationError(`status must be one of ${[...MASTER_LISTING_STATUSES].join(", ")}`);
  }
  const id = optionalString(input.id, "id", { maxLength: 100 }) ?? crypto.randomUUID();

  await env.DIRECTORY_DB.prepare(
    `INSERT INTO master_listings
       (id, source, source_id, name, category, subcategories, address, city, region, country, lat, lng, phone, website, attributes, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       source = excluded.source, source_id = excluded.source_id, name = excluded.name, category = excluded.category,
       subcategories = excluded.subcategories, address = excluded.address, city = excluded.city, region = excluded.region,
       country = excluded.country, lat = excluded.lat, lng = excluded.lng, phone = excluded.phone, website = excluded.website,
       attributes = excluded.attributes, status = excluded.status, updated_at = datetime('now')`,
  )
    .bind(
      id, source, source_id, name, category, subcategories, address, city, region,
      country, lat, lng, phone, website, attributes, status,
    )
    .run();

  await logAudit(env, {
    action: "upsert_master_listing",
    listing_id: id,
    actor: actorFrom(request),
    detail: { name, status },
  });
  return { id, source, source_id, name, category, city, region, country, status };
}

export async function upsertListingSiteLink(env: Env, request: Request, input: Record<string, unknown>) {
  const listing_id = requireString(input.listing_id, "listing_id", { maxLength: 100 });
  const site_id = requireString(input.site_id, "site_id", { maxLength: 100 });
  const wp_post_id = optionalNumber(input.wp_post_id, "wp_post_id");
  const publish_status = optionalString(input.publish_status, "publish_status", { maxLength: 40 }) ?? "queued";
  if (!PUBLISH_STATUSES.has(publish_status)) {
    throw new ValidationError(`publish_status must be one of ${[...PUBLISH_STATUSES].join(", ")}`);
  }
  const last_error = optionalString(input.last_error, "last_error", { maxLength: 1000 });

  const listing = await env.DIRECTORY_DB.prepare(`SELECT id FROM master_listings WHERE id = ?`)
    .bind(listing_id)
    .first();
  if (!listing) throw new ValidationError(`Unknown listing_id: ${listing_id}`);
  const site = await env.DIRECTORY_DB.prepare(`SELECT id FROM sites WHERE id = ?`).bind(site_id).first();
  if (!site) throw new ValidationError(`Unknown site_id: ${site_id}`);

  await env.DIRECTORY_DB.prepare(
    `INSERT INTO listing_site_links (listing_id, site_id, wp_post_id, publish_status, last_attempt_at, last_error)
     VALUES (?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(listing_id, site_id) DO UPDATE SET
       wp_post_id = excluded.wp_post_id, publish_status = excluded.publish_status,
       last_attempt_at = datetime('now'), last_error = excluded.last_error`,
  )
    .bind(listing_id, site_id, wp_post_id, publish_status, last_error)
    .run();

  await logAudit(env, {
    action: "upsert_listing_site_link",
    site_id,
    listing_id,
    actor: actorFrom(request),
    detail: { publish_status },
  });
  return { listing_id, site_id, wp_post_id, publish_status };
}

export async function enqueuePublish(env: Env, request: Request, input: Record<string, unknown>) {
  const listing_id = requireString(input.listing_id, "listing_id", { maxLength: 100 });
  const site_id = requireString(input.site_id, "site_id", { maxLength: 100 });
  const action = requireString(input.action, "action", { maxLength: 40 });
  if (!PUBLISH_ACTIONS.has(action)) {
    throw new ValidationError(`action must be one of ${[...PUBLISH_ACTIONS].join(", ")}`);
  }
  const requested_by = optionalString(input.requested_by, "requested_by", { maxLength: 200 }) ?? actorFrom(request);

  const listing = await env.DIRECTORY_DB.prepare(`SELECT id FROM master_listings WHERE id = ?`)
    .bind(listing_id)
    .first();
  if (!listing) throw new ValidationError(`Unknown listing_id: ${listing_id}`);
  const site = await env.DIRECTORY_DB.prepare(`SELECT id FROM sites WHERE id = ?`).bind(site_id).first();
  if (!site) throw new ValidationError(`Unknown site_id: ${site_id}`);

  const inserted = await env.DIRECTORY_DB.prepare(
    `INSERT INTO publish_queue (listing_id, site_id, action, requested_by) VALUES (?, ?, ?, ?)`,
  )
    .bind(listing_id, site_id, action, requested_by)
    .run();

  await logAudit(env, {
    action: "enqueue_publish",
    site_id,
    listing_id,
    actor: actorFrom(request),
    detail: { action },
  });
  return { id: inserted.meta.last_row_id, listing_id, site_id, action, requested_by };
}

export async function listPublishQueue(env: Env, filters: { site_id?: string; listing_id?: string }) {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filters.site_id) {
    conditions.push("site_id = ?");
    params.push(filters.site_id);
  }
  if (filters.listing_id) {
    conditions.push("listing_id = ?");
    params.push(filters.listing_id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await env.DIRECTORY_DB.prepare(
    `SELECT id, listing_id, site_id, action, requested_by, created_at FROM publish_queue ${where} ORDER BY id ASC LIMIT 200`,
  )
    .bind(...params)
    .all();
  return { items: result.results ?? [] };
}

export async function dequeuePublish(env: Env, request: Request, id: number) {
  const existing = await env.DIRECTORY_DB.prepare(
    `SELECT id, listing_id, site_id, action FROM publish_queue WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: number; listing_id: string; site_id: string; action: string }>();
  if (!existing) throw new ValidationError(`Unknown publish_queue id: ${id}`);
  await env.DIRECTORY_DB.prepare(`DELETE FROM publish_queue WHERE id = ?`).bind(id).run();
  await logAudit(env, {
    action: "dequeue_publish",
    site_id: existing.site_id,
    listing_id: existing.listing_id,
    actor: actorFrom(request),
    detail: { queue_id: id, queued_action: existing.action },
  });
  return { id, dequeued: true };
}

// The three functions below proxy through to GeoDirectory's own geodir/v2
// REST API on the target site, rather than through master_listings/D1 --
// they configure the site itself (categories, tags, settings), not listing
// data. This is the cross-site automation lever from "start scoping" ->
// "let's do a combo" -- see worker-multisite-scoping.md and
// architecture-overview.md for the full writeup, including why custom
// fields are NOT covered here (no write endpoint exists for those).

export async function upsertGeodirCategory(env: Env, request: Request, input: Record<string, unknown>) {
  const site_id = requireString(input.site_id, "site_id", { maxLength: 100 });
  const name = requireString(input.name, "name", { maxLength: 200 });
  const description = optionalString(input.description, "description", { maxLength: 2000 });
  const slug = optionalString(input.slug, "slug", { maxLength: 200 });
  const parent = optionalNumber(input.parent, "parent");
  const fa_icon = optionalString(input.fa_icon, "fa_icon", { maxLength: 100 });
  const fa_icon_color = optionalString(input.fa_icon_color, "fa_icon_color", { maxLength: 20 });
  const id = optionalNumber(input.id, "id");

  const connection = await resolveSiteConnection(env, site_id);
  const body: Record<string, unknown> = { name };
  if (description !== null) body.description = description;
  if (slug !== null) body.slug = slug;
  if (parent !== null) body.parent = parent;
  if (fa_icon !== null) body.fa_icon = fa_icon;
  if (fa_icon_color !== null) body.fa_icon_color = fa_icon_color;

  const upstream = await wordpressWrite(
    connection,
    geodirCategoriesPath(id ?? undefined),
    id ? "PUT" : "POST",
    body,
  );

  await logAudit(env, {
    action: "upsert_geodir_category",
    site_id,
    actor: actorFrom(request),
    detail: { name, id, parent },
  });
  return upstream;
}

export async function upsertGeodirTag(env: Env, request: Request, input: Record<string, unknown>) {
  const site_id = requireString(input.site_id, "site_id", { maxLength: 100 });
  const name = requireString(input.name, "name", { maxLength: 200 });
  const description = optionalString(input.description, "description", { maxLength: 2000 });
  const slug = optionalString(input.slug, "slug", { maxLength: 200 });
  const id = optionalNumber(input.id, "id");

  const connection = await resolveSiteConnection(env, site_id);
  const body: Record<string, unknown> = { name };
  if (description !== null) body.description = description;
  if (slug !== null) body.slug = slug;

  const upstream = await wordpressWrite(connection, geodirTagsPath(id ?? undefined), id ? "PUT" : "POST", body);

  await logAudit(env, {
    action: "upsert_geodir_tag",
    site_id,
    actor: actorFrom(request),
    detail: { name, id },
  });
  return upstream;
}

export async function updateGeodirSettings(env: Env, request: Request, input: Record<string, unknown>) {
  const site_id = requireString(input.site_id, "site_id", { maxLength: 100 });
  const group_id = requireString(input.group_id, "group_id", { maxLength: 100 });
  const setting_id = requireString(input.id, "id", { maxLength: 100 });
  if (input.value === undefined) throw new ValidationError("value is required");

  const connection = await resolveSiteConnection(env, site_id);
  const upstream = await wordpressWrite(connection, geodirSettingsPath(group_id), "PUT", {
    id: setting_id,
    value: input.value,
  });

  await logAudit(env, {
    action: "update_geodir_settings",
    site_id,
    actor: actorFrom(request),
    detail: { group_id, id: setting_id },
  });
  return upstream;
}

export async function runWriteOperation(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  request: Request,
): Promise<unknown> {
  switch (name) {
    case "upsert_site_profile":
      return upsertSiteProfile(env, request, args);
    case "upsert_site":
      return upsertSite(env, request, args);
    case "upsert_integration_connection":
      return upsertIntegrationConnection(env, request, args);
    case "upsert_master_listing":
      return upsertMasterListing(env, request, args);
    case "upsert_listing_site_link":
      return upsertListingSiteLink(env, request, args);
    case "enqueue_publish":
      return enqueuePublish(env, request, args);
    case "dequeue_publish": {
      const id = args.id;
      if (typeof id !== "number" || !Number.isInteger(id)) throw new ValidationError("id must be an integer");
      return dequeuePublish(env, request, id);
    }
    case "upsert_geodir_category":
      return upsertGeodirCategory(env, request, args);
    case "upsert_geodir_tag":
      return upsertGeodirTag(env, request, args);
    case "update_geodir_settings":
      return updateGeodirSettings(env, request, args);
    default:
      throw new Error("Unknown write operation");
  }
}

export function safeWriteError(error: unknown): string {
  if (error instanceof ValidationError) return error.message;
  return error instanceof Error ? error.message : "Write operation failed";
}
