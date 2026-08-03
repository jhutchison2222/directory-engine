import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { defaultHandler, MCP_RESOURCE, mcpApiHandler, READ_SCOPE } from "./index";
import type { Env } from "./types";

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: [READ_SCOPE],
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: ["https://directory-engine-api.jhutchison.workers.dev"],
    scopes_supported: [READ_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Directory Engine Read-Only",
  },
  accessTokenTTL: 3600,
  refreshTokenTTL: 2_592_000,
  allowImplicitFlow: false,
  allowPlainPKCE: false,
});
