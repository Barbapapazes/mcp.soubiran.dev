# MCP authentication

## Separate machine and user entrypoints

| Endpoint | Caller | Authentication |
| --- | --- | --- |
| `/internal/mcp` | API website assistant | Cloudflare Access at the edge |
| `/mcp` | External MCP clients | Passport OAuth in the Worker |
| `/infra/mcp` | External infrastructure clients | Passport OAuth in the Worker |

The internal route reuses the content tools (`search_content`, `list_pages`,
`get_page`) with a content-only service principal. It never registers topology
tools. Tool callbacks retain their permission checks.

**The Worker deliberately knows nothing about Cloudflare Access.** It does not
read Access headers, validate Access JWTs, or require an OAuth token on the
internal route. A request reaching that route is trusted. The edge policy and
the absence of bypass routes are therefore mandatory deployment prerequisites,
not optional hardening.

## Required Cloudflare configuration

Before deploying the internal route:

1. Create an Access application covering `mcp.soubiran.dev/internal/*` and a
   **Service Auth** policy allowing only a dedicated API service token. Do not
   use a Bypass policy or a browser-login-only policy.
2. Keep `/mcp`, `/infra/mcp`, their protected-resource metadata, and the OpenAI
   verification route outside this Access application. They must not receive
   Access login redirects or browser challenges.
3. Apply `worker.workersDev: false` and `worker.previewUrls: false` from
   `cloudflare.config.ts` through the production deployment process. Ensure
   existing preview URLs, custom-domain previews, alternate domains/routes, and
   any other public invocation paths cannot bypass Access for `/internal/*`.
   Do not expose this Worker through an unprotected secondary hostname.
4. Store the service token only in the API secret manager. Rotate/revoke it
   through Access; no matching secret or Access configuration belongs in the
   Worker.

Repository settings do not change the live account by themselves. A version
upload alone is not proof that production subdomain/preview settings changed.
The operator must apply the edge policy and disable existing bypass paths before
making the internal handler reachable. No live Cloudflare configuration or
deployment has been performed by this change.

## API assistant configuration

Set:

- `ASSISTANT_MCP_URL=https://mcp.soubiran.dev/internal/mcp`
- `ASSISTANT_MCP_ACCESS_CLIENT_ID`
- `ASSISTANT_MCP_ACCESS_CLIENT_SECRET`

Laravel sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` on MCP requests.
It requires credentials and an HTTPS internal endpoint, refuses serialization
of the credential-bearing transport, and does not fall back to public MCP or
retry authentication failures.

There is no service OAuth client, token endpoint call, token cache, shared cache
lock, refresh, or service-specific Passport token lifetime. Remove obsolete
`ASSISTANT_MCP_TOKEN_URL`, `ASSISTANT_MCP_CLIENT_ID`, and
`ASSISTANT_MCP_CLIENT_SECRET` settings. Retire an already-provisioned assistant
Passport client after all API instances have switched. The Worker's
`PASSPORT_SERVICE_CLIENT_ID` binding is removed.

## External OAuth: Passport remains the only authorization server

The public endpoints retain PR #31's OAuth resource-server behavior. The Worker
does not implement registration, login, consent, authorization codes, token
issuance, or refresh. Old Worker-issued tokens are not accepted; old
`/authorize`, `/oauth/*`, and authorization-server discovery routes return 404.

Protected-resource metadata is available at:

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-protected-resource/infra/mcp`

Both advertise `https://api.soubiran.dev` as their only authorization server.
Unauthorized requests return a discovery-linked 401 Bearer challenge. Public
preflight and metadata support the configured CORS origin. Access credentials
do not authenticate callers to these endpoints. Former native Passport service
tokens (client-ID audience, no issuer) are no longer accepted.

### Interactive API prerequisites remain a deployment blocker

The companion API PR #153 provides JWKS and upstream identity capabilities,
**not complete direct interactive MCP OAuth**. This change does not implement
the missing API support. Do not deploy the public endpoints as a complete
interactive integration until Passport provides:

- RFC 8414 authorization-server metadata at
  `https://api.soubiran.dev/.well-known/oauth-authorization-server` with that issuer.
- Authorization-code flow with S256 PKCE, public-client support, strict redirect
  validation, and user consent to the resource/scopes.
- Client registration compatible with intended clients (pre-registration,
  dynamic registration, and/or Client ID Metadata Documents as required).
- RFC 8707 resource binding at authorization and code exchange, binding each
  code and resulting token to exactly one allowed resource.
- RS256 MCP user tokens containing `iss=https://api.soubiran.dev`, a single
  resource `aud`, nonempty user `sub`, `iat`, `nbf`, `exp`, `jti`, and an array
  `scopes`, with a maximum five-minute lifetime. Ordinary API and
  client_credentials grants must not acquire this profile.
- Refresh behavior that does not broaden the original resource or scopes.

| Resource / required audience | Required scope |
| --- | --- |
| `https://mcp.soubiran.dev/mcp` | `mcp:content:read` |
| `https://mcp.soubiran.dev/infra/mcp` | `mcp:infra:read` |

Empty scopes authenticate but return 403. Wildcards, mixed-resource scopes,
multi-audience tokens, incorrect issuers, and ordinary Passport client-audience
tokens are rejected. The API must decide infrastructure authorization through
its consent/permission policy.

Stock Passport 13 / League 9.4 tokens use a client-ID audience and omit `iss`.
Discovery metadata alone cannot satisfy this contract; do not weaken the
Worker's audience checks to make ordinary API tokens work.

### Worker OAuth configuration

- `PASSPORT_JWKS_URL`: trusted HTTPS JWKS URL, default
  `https://api.soubiran.dev/.well-known/jwks.json`.
- `CORS_ALLOWED_ORIGIN`: allowed browser origin.

JWKS is fetched only from the administrator-configured URL and cached per
isolate for five minutes. JWTs are verified locally with `jose`; there is no
per-request introspection. Revocation takes effect at expiry (at most five
minutes). Keep Passport's existing key pair and public JWKS endpoint.

No OAuth KV or interactive client secret is required in the Worker. The API's
upstream identity endpoint/client is not a substitute for direct interactive
resource-bound OAuth.

## Rollout and telemetry

1. Provision Access, the dedicated service token, and all route/bypass controls.
2. Deploy the Worker with the internal route and disabled alternate URLs only
   after the edge prerequisites are in place.
3. Configure and deploy every API instance with the internal URL and Access
   credentials, then retire obsolete service OAuth credentials/settings.
4. Roll out interactive clients separately, after the API prerequisites above
   are complete. Reconnect clients against Passport; old Worker-issued tokens
   and registrations do not migrate.

Redact both Access credential headers, Access assertions, OAuth tokens,
authorization headers, cookies, codes, and secrets from API, proxy, and edge
telemetry. Worker logging omits request headers/query strings; Sentry strips
request/breadcrumb payloads. Apply authorization/token abuse limits on the API.

Tests were updated but not executed. No builds, tests, lint, format checks,
type checks, static analysis, or CI verification were run.
