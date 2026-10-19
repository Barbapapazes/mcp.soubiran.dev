# MCP authentication and rollout

## Trust boundaries

- External MCP clients use OAuth 2.1 with S256 PKCE, browser-bound consent, and Passport as the upstream sign-in provider. `@cloudflare/workers-oauth-provider` 1.2.3 issues its **own** opaque access tokens. Passport access/refresh tokens are not passed through, returned to clients, or stored in Worker grants.
- Two resources have separate audiences: `https://mcp.soubiran.dev/mcp` (`mcp:content:read`) and `https://mcp.soubiran.dev/infra/mcp` (`mcp:infra:read`). Consent only grants the scope for the selected resource. Infrastructure is the existing published, read-only snapshot; interactive authenticated users may consent to it. This is not an administrator/live-infrastructure credential.
- The website assistant uses a **dedicated confidential Passport client_credentials client**, never the interactive client. Its JWT is accepted only on `/mcp`, with exactly `mcp:content:read`. Every tool callback independently enforces permissions: only `search_content`, `list_pages`, and `get_page` are available to the service. No service token can execute `query_topology`, even with an infrastructure scope.
- JWT-shaped credentials go only to the Passport validator. Worker tokens go only to the Worker authorization server. Failed authentication never falls back to anonymous MCP, an API key, introspection, or upstream validation on each tool request.

Passport 13.10 / League OAuth2 Server 9.4.1 emit RS256 JWTs with `aud` identifying the OAuth client, `sub` identifying the client for client_credentials, and permissions in the **array** `scopes`. They include `iat`, `nbf`, `exp`, and `jti`, but no `iss` or `kid`. The validator checks that exact profile, the dedicated client identity, a single audience, a maximum five-minute lifetime, and the exact service scope. It does not treat Passport's client audience as an MCP resource audience: the dedicated-client policy explicitly maps it to the content resource after successful validation.

The API publishes `GET /.well-known/jwks.json` using the already installed phpseclib 4 exporter. It reads only the configured Passport public PEM (including escaped newlines), or the existing `oauth-public.key` file. It never loads or publishes the private key, creates another key pair, or introduces a `kid`. `jose` 6.2.12 retrieves the JWKS from the administrator-configured trusted HTTPS URL, not any JWT header, and caches it in each isolate for five minutes. Signatures and temporal claims are verified locally; there is no per-request API call.

## Provisioning

Do not run `passport:keys` or `install:api`. Preserve the existing Passport key pair.

Create two clients with the existing Passport CLI on the API deployment host. Run in an unrecorded administrative session, with tracing disabled and restrictive file permissions: these commands print the new client secret. Redirect their output to temporary **private server-side files**, import into the secret manager, and securely remove those files afterwards. Do not paste secrets into tickets, prompts, shell command arguments, build logs, or the browser.

```sh
umask 077
php artisan passport:client --client --name="Website assistant MCP content" --no-interaction > /secure/assistant-mcp-client.txt
php artisan passport:client --name="MCP Passport sign-in" --redirect_uri="https://mcp.soubiran.dev/oauth/callback" --no-interaction > /secure/interactive-mcp-client.txt
```

The application scope repository reserves `mcp:content:read` to the configured service client and the client_credentials grant. That client's other requested scopes (including `*`) are removed. `mcp:identity` is reserved to the interactive client and authorization_code/refresh_token grants. Existing unrelated clients/scopes are preserved. No database alteration is necessary.

API server configuration (never frontend/Vite variables):

| Variable | Value |
| --- | --- |
| `ASSISTANT_MCP_URL` | `https://mcp.soubiran.dev/mcp` |
| `ASSISTANT_MCP_TOKEN_URL` | `https://api.soubiran.dev/oauth/token` |
| `ASSISTANT_MCP_CLIENT_ID` | Dedicated service client ID |
| `ASSISTANT_MCP_CLIENT_SECRET` | Dedicated service client secret, **API only** |
| `MCP_INTERACTIVE_CLIENT_ID` | Other, authorization-code client ID |
| `CACHE_STORE` | Private shared cache supporting atomic locks, e.g. Redis/database; not `array` in production |

The API sets Passport's client_credentials lifetime to five minutes (this applies to **all** client_credentials clients, not user/personal access grants). Its MCP token cache uses a 30-second expiry margin and a double-checked shared lock. Compare-and-delete invalidation avoids one rejected old token evicting another request's fresh token. Only `401` with `Bearer error="invalid_token"` triggers invalidation and one retry; 403, network failures, and unrelated challenges do not. A second invalid-token response invalidates the second token but is not retried again. The transport refuses serialization so a credential cannot leak through a serialized client recipe.

Worker configuration:

| Binding | Value |
| --- | --- |
| `OAUTH_KV` | Persistent private Workers KV namespace for this authorization server |
| `PASSPORT_JWKS_URL` | Trusted HTTPS URL, default `https://api.soubiran.dev/.well-known/jwks.json` |
| `PASSPORT_SERVICE_CLIENT_ID` | Exactly `ASSISTANT_MCP_CLIENT_ID`; **no service secret in the Worker** |
| `PASSPORT_INTERACTIVE_CLIENT_ID` | Exactly `MCP_INTERACTIVE_CLIENT_ID` |
| `PASSPORT_INTERACTIVE_CLIENT_SECRET` | Only the authorization-code client's secret |

`bindings.kv()` provisions the namespace through `cf deploy`. Alternatively, pre-create it and set `bindings.kv({ id: 'the-returned-namespace-id' })` before deployment:

```sh
pnpm exec cf kv namespaces create --title mcp-soubiran-oauth
```

Import the three Worker secret bindings through the dashboard/secret manager or a private bulk file, never `--text` shell arguments. The CLI's bulk file maps each binding name to `{ "type": "secret_text", "text": "..." }` (use real values only inside the protected server-side file):

```sh
pnpm exec cf workers secrets bulk --worker mcp-soubiran-dev --file /secure/mcp-worker-secrets.json
```

Ensure secrets are applied to the version being activated, not just an older version. Production issuer/resource/callback URLs are intentionally fixed. Do not route preview domains to production OAuth storage; provision isolated issuers/clients/storage if a preview environment is needed. `global_fetch_strictly_public` is enabled for client metadata document fetching. Keep the public JWKS, OAuth discovery/registration/token/consent/callback endpoints reachable through the edge; do not put a browser challenge in front of protocol endpoints.

## Deployment order: keep the existing chat working

The API changes deliberately have two commits/releases:

1. Provision the clients and configure server-side secrets. Deploy API commit **`df35bf0`** first (JWKS, identity endpoint, reserved scopes, five-minute service TTL). This commit does **not** switch the existing chat client. Wait for this capability release to reach **all** API instances before proceeding, so a token request cannot hit an old instance that lacks the scope.
2. Deploy the final API commit (authenticated assistant transport/cache). Refresh Laravel configuration and restart long-lived workers using the normal deployment pipeline. The current MCP deployment still accepts requests; the assistant already sends its Bearer token. There is no fallback branch or temporary unauthenticated mode in the new client.
3. Only after step 2 has reached all chat-serving API instances, activate this Worker version with `OAUTH_KV` and all three secret bindings. Both MCP endpoints now require authentication. Reversing steps 2 and 3 would break the existing chat.
4. Configure external clients with `/mcp` or `/infra/mcp` and the appropriate resource/scope. They discover this Worker's authorization server, not Passport directly. Reconnect existing anonymous clients through consent.

Build artifacts and generate Cloudflare types in the normal remote build pipeline, then deploy those artifacts. No builds, tests, lint, type checks, or CI verification were run by the implementing agent. Commits carry `[skip ci]` to avoid triggering verification; normal release/artifact production must be scheduled separately by the operator. Do not roll back the authenticated API client to the old anonymous client while leaving the protected Worker active. Never make the Worker public as a recovery strategy.

## Security operations and limitations

- Tokens are five minutes long; interactive refresh tokens are disabled, so clients must reauthorize on expiry. There is no upstream refresh-token retention or refresh machinery. Passport's upstream sign-in access token is discarded after the single identity lookup.
- **Revocation of a Passport service token validated locally takes effect only when that token expires**, at most five minutes after issuance. Client revocation/secret changes prevent future issuance but do not invalidate an already signed JWT in the Worker. JWKS caching is not introspection. No key rotation or per-token revocation mechanism is implemented.
- The direct Passport service-token path is an explicitly restricted first-party service integration, not the interactive MCP OAuth profile. External clients must use Worker-issued resource-bound tokens.
- Cloudflare KV has eventual-consistency/single-use-transaction race limitations documented by the provider. No custom cryptography or locking is added around its consent/upstream helpers.
- Keep caches, OAuth KV, secret managers, and deployment files private. Exclude OAuth request/response payloads, Authorization headers, codes, states, and secrets from edge/platform logs. The Worker logs only sanitized request paths, disables persisted traces, strips Sentry request/breadcrumb data, and never logs upstream token responses. Keep Laravel Nightwatch outgoing-request/payload capture disabled and existing credential redactions enabled. Audit any independent proxy/access-log collection as well.
- Add edge abuse limits to public registration/authorization/token endpoints appropriate to traffic. The application does not provide a new registration anti-abuse service.
- Regression tests cover actual signed Passport-shaped JWTs and JWKS caching/failures, resource isolation, execution-time tool permissions, consent escaping/browser binding/replay, PKCE flow, Worker-owned token issuance, Passport scope restrictions/JWKS output, and Laravel token caching/retry behavior. Node OAuth integration tests use an in-memory KV and a WorkerEntrypoint shape shim, not a claim of production workerd testing. Tests have been added but **not executed**.

## References consulted

- [Cloudflare MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/authorization/)
- [workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider), including consent, upstream sign-in, resource-server and authorization-server references and the published 1.2.3 API declarations
- [Passport documentation](https://laravel.com/docs/12.x/passport), [Passport 13.10 source](https://github.com/laravel/passport/tree/v13.10.0), [League JWT generation, 9.4.1](https://github.com/thephpleague/oauth2-server/blob/9.4.1/src/Entities/Traits/AccessTokenTrait.php)
- [Laravel MCP client documentation](https://laravel.com/docs/13.x/mcp#connecting-to-external-mcp-servers), [Laravel MCP 1.0.1 HTTP transport](https://github.com/laravel/mcp/blob/v1.0.1/src/Client/Transport/HttpTransport.php)
- [jose remote JWKS](https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md)
- [phpseclib key formats](https://phpseclib.com/docs/publickeys), [phpseclib 4 JWK export](https://github.com/phpseclib/phpseclib/blob/4.0.1/phpseclib/Crypt/Common/Formats/Keys/JWK.php)
- [Laravel cache locks](https://laravel.com/docs/12.x/cache#atomic-locks), [HTTP client](https://laravel.com/docs/12.x/http-client)
