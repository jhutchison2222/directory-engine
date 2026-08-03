import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import { constantTimeEqual } from "./security";
import type { Env } from "./types";

const READ_SCOPE = "mcp:read";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function page(request: Request, client: ClientInfo, errorMessage = ""): Response {
  const action = escapeHtml(new URL(request.url).pathname + new URL(request.url).search);
  const clientName = escapeHtml(client.clientName || "ChatGPT");
  const error = errorMessage ? `<p class="error" role="alert">${escapeHtml(errorMessage)}</p>` : "";
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize Directory Engine</title>
  <style>
    :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3f5f7; color: #17202a; }
    main { width: min(32rem, calc(100% - 2rem)); box-sizing: border-box; padding: 2rem; border-radius: 1rem; background: white; box-shadow: 0 1rem 3rem #17202a20; }
    h1 { margin-top: 0; font-size: 1.5rem; }
    label { display: block; margin: 1.25rem 0 .4rem; font-weight: 650; }
    input, button { width: 100%; box-sizing: border-box; padding: .8rem; border-radius: .55rem; font: inherit; }
    input { border: 1px solid #aab3bd; }
    button { margin-top: 1rem; border: 0; background: #1769aa; color: white; font-weight: 700; cursor: pointer; }
    .scope { padding: .8rem; border-radius: .55rem; background: #eef5fb; }
    .error { color: #b42318; font-weight: 650; }
    small { display: block; margin-top: 1rem; color: #53606d; }
    @media (prefers-color-scheme: dark) {
      body { background: #111820; color: #edf2f7; } main { background: #1b2632; }
      .scope { background: #23364a; } small { color: #bcc7d2; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Authorize Directory Engine Read-Only</h1>
    <p><strong>${clientName}</strong> is requesting access.</p>
    <p class="scope">Permission: inspect the existing Directory Engine WordPress, GeoDirectory, and D1 configuration using 13 read-only tools.</p>
    ${error}
    <form method="post" action="${action}">
      <label for="access_code">Owner access code</label>
      <input id="access_code" name="access_code" type="password" required autocomplete="current-password" maxlength="256" autofocus>
      <button type="submit">Authorize read-only access</button>
    </form>
    <small>This does not grant create, update, delete, publish, migration, or SQL execution access.</small>
  </main>
</body>
</html>`;
  return new Response(body, {
    status: errorMessage ? 401 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function invalidRequest(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

async function validatedAuthorization(request: Request, env: Env): Promise<{
  oauthRequest: AuthRequest;
  client: ClientInfo;
} | Response> {
  let oauthRequest: AuthRequest;
  try { oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request); }
  catch { return invalidRequest("Invalid authorization request"); }

  if (oauthRequest.scope.some((scope) => scope !== READ_SCOPE) || !oauthRequest.scope.includes(READ_SCOPE)) {
    return invalidRequest("The request must use only the mcp:read scope");
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return invalidRequest("Unknown OAuth client");
  return { oauthRequest, client };
}

export async function handleAuthorization(request: Request, env: Env): Promise<Response> {
  if (!env.DIRECTORY_ENGINE_OAUTH_ACCESS_CODE) {
    return invalidRequest("OAuth authorization is not configured", 503);
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return invalidRequest("Method not allowed", 405);
  }
  const validated = await validatedAuthorization(request, env);
  if (validated instanceof Response) return validated;
  const { oauthRequest, client } = validated;
  if (request.method === "GET") return page(request, client);

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 8192 || !request.headers.get("content-type")?.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return invalidRequest("Invalid authorization form");
  }
  const form = await request.formData();
  const supplied = form.get("access_code");
  if (typeof supplied !== "string" || !constantTimeEqual(supplied, env.DIRECTORY_ENGINE_OAUTH_ACCESS_CODE)) {
    return page(request, client, "The owner access code was not accepted.");
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: "directory-engine-owner",
    metadata: { clientName: client.clientName || "OAuth client" },
    scope: [READ_SCOPE],
    props: { permissions: [READ_SCOPE], role: "owner" },
  });
  return Response.redirect(redirectTo, 302);
}
