# MCP authentication with Passport

## One authorization server

**Laravel Passport at `https://api.soubiran.dev` is the only authorization server.**
The Worker is an OAuth protected resource, not an authorization server. It does
not implement registration, login, consent, authorization codes, token issuance,
or refresh. It has no OAuth KV namespace or OAuth client secret. Its old
`/authorize`, `/oauth/*`, and authorization-server discovery routes return 404.
Previously issued Worker tokens are no longer accepted.

The Worker publishes protected-resource metadata at:

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-protected-resource/infra/mcp`

Both advertise Passport as their only authorization server. Unauthorized MCP
requests return a 401 Bearer challenge pointing to the appropriate metadata.
Discovery and authentication errors support browser CORS using the configured
origin; preflight does not require credentials. Query-string tokens are not
accepted. Permissions are checked again inside each tool callback.

## Interactive clients: Passport prerequisites (deployment blocker)

The previous API companion changes (`df35bf0` / `e2757cd` on
`feat/mcp-auth-passport`) only provide JWKS, an upstream identity scope, and the
assistant service transport. **They do not yet implement direct interactive MCP
OAuth. Do not deploy this as a complete interactive integration until the API
work below is implemented.** The Worker fails closed in the meantime; it does
not fall back to arbitrary Passport API tokens or a second issuer.

The client flow is now:

1. Client discovers the resource metadata on the Worker.
2. Client discovers authorization-server metadata on the API.
3. Passport handles authorization, user consent, S256 PKCE, and code exchange.
4. Client sends a Passport-issued MCP access token directly to the Worker.

Passport must provide:

- RFC 8414 authorization-server metadata at
  `https://api.soubiran.dev/.well-known/oauth-authorization-server`, with that
  exact issuer and the API's authorization/token endpoints.
- Authorization-code flow with S256 PKCE, including public clients, strict
  redirect validation, and user consent to the selected resource and scopes.
- A registration model compatible with the intended clients. Pre-register known
  clients where supported; implement dynamic registration and/or Client ID
  Metadata Documents only if needed by the clients. The Worker does neither.
- RFC 8707 resource validation at authorization and token exchange: bind codes
  and resulting access tokens to exactly one allowed MCP resource. Never
  silently ignore the `resource` parameter or issue resource tokens merely
  because a caller requests an audience.
- MCP-specific user tokens with RS256 signatures, `iss` equal to
  `https://api.soubiran.dev`, a **single resource audience**, nonempty user `sub`,
  `iat`, `nbf`, `exp`, `jti`, and an array `scopes`. Maximum lifetime is five
  minutes. Restrict this token profile to authorized interactive user grants;
  ordinary API and client_credentials grants must not acquire it.
- Appropriate refresh behavior on the API if desired, without broadening the
  originally authorized resource or scopes.

| Resource / required `aud` | Allowed / required scope |
| --- | --- |
| `https://mcp.soubiran.dev/mcp` | `mcp:content:read` |
| `https://mcp.soubiran.dev/infra/mcp` | `mcp:infra:read` |

Empty scopes authenticate but return 403 at the resource. Wildcards, mixed
resource scopes, multi-audience tokens, other issuers, and ordinary Passport
client-audience user tokens are rejected. Infrastructure authorization must be
decided by the API's consent/permission policy; the endpoint exposes the existing
read-only published snapshot, not live administrator credentials.

**Stock Passport tokens do not satisfy this interactive contract:** Passport
13 / League 9.4 normally uses the OAuth client ID as `aud` and omits `iss`.
Publishing discovery metadata alone is not enough. Adapt token issuance and
resource/code binding in the API; do not weaken Worker audience checks to make
ordinary API tokens work.

## First-party website assistant

The existing dedicated Passport `client_credentials` path remains supported on
`/mcp` only. It deliberately accepts Passport's native profile (no `iss` or
`kid`, client ID as the sole `aud` and `sub`, `scopes` exactly
`["mcp:content:read"]`, `iat`, `nbf`, `exp`, `jti`, at most five minutes).
The configured dedicated client maps explicitly to the content resource. It
cannot access infrastructure or any tools except `search_content`, `list_pages`,
and `get_page`. This is a restricted first-party exception, not the interactive
MCP token profile.

Keep the existing Passport key pair. Do not run `passport:keys` or `install:api`.
Create the dedicated service client in an unrecorded administrative session;
its secret belongs only in the API secret manager, never in the Worker,
browser, logs, tickets, or shell arguments.

The API companion changes reserve the service scope to the dedicated client,
set client_credentials lifetimes to five minutes, and send cached Bearer tokens
from the server-side assistant transport. The private shared cache needs atomic
locks. Only a 401 `Bearer error="invalid_token"` invalidates a cached token and
permits one retry; 403 and unrelated errors do not. The Worker preserves this
challenge behavior.

## Worker configuration

| Binding | Purpose |
| --- | --- |
| `PASSPORT_JWKS_URL` | Trusted HTTPS JWKS URL; default `https://api.soubiran.dev/.well-known/jwks.json` |
| `PASSPORT_SERVICE_CLIENT_ID` | Dedicated assistant client ID (not its secret) |
| `CORS_ALLOWED_ORIGIN` | Allowed browser origin |

There is no `OAUTH_KV`, `PASSPORT_INTERACTIVE_CLIENT_ID`, or
`PASSPORT_INTERACTIVE_CLIENT_SECRET` binding. Remove obsolete secrets and KV
bindings through the deployment configuration. Retire the old upstream sign-in
client in Passport after migration; do not revoke the assistant service client.
Keep old token storage only as long as operational retention requires, then
remove the unused namespace. No new storage is provisioned by the Worker.

JWKS is fetched only from the administrator-configured URL, never a JWT header,
and cached per isolate for five minutes. Tokens are verified locally; there is
no per-request introspection. Revocation is therefore effective at token expiry
(at most five minutes), not immediately. Preserve the API's public JWKS endpoint
and restrict all private keys to the API.

## Rollout

1. Provision the dedicated assistant client and API-side settings:
   `ASSISTANT_MCP_URL`, `ASSISTANT_MCP_TOKEN_URL`, `ASSISTANT_MCP_CLIENT_ID`,
   `ASSISTANT_MCP_CLIENT_SECRET`, and a private shared `CACHE_STORE`. Deploy the
   companion API's JWKS/scope capabilities to every instance before switching
   the assistant transport to authenticated requests.
2. Implement and deploy the direct interactive Passport prerequisites above
   before promising external-client support. Existing upstream identity lookup
   endpoints and sign-in-only clients are not a substitute.
3. Configure the Worker's JWKS URL and dedicated service client ID. Deploy only
   after every chat-serving API instance sends authenticated assistant calls.
   Do not restore anonymous Worker access to recover from deployment problems.
4. Reconnect interactive clients against Passport. Worker-issued access/refresh
   tokens and previous Worker OAuth client registrations do not migrate.

Keep protocol endpoints reachable without browser challenges. Redact tokens,
OAuth payloads, authorization headers, cookies, codes, and secrets from API,
proxy, and edge telemetry. Worker request logging omits query strings and Sentry
request/breadcrumb payloads. Apply authorization/token abuse limits on the API.

Tests were updated but not executed. No builds, tests, lint, type checks, or CI
verification were run. Build artifacts remotely and deploy via the operator's
normal release process.
