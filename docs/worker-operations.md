# Worker deployment and monitoring policy

The active deployment configuration is `cloudflare.config.ts`. The legacy
`wrangler.jsonc` is not used. `wrangler.config.ts` only controls Wrangler tooling.

## Public previews

`worker.previewUrls: false` declares that branch/version previews must not be
public. Keep preview code away from production bindings. If interactive previews
are needed, use an isolated Worker/environment with separate bindings and an
explicit access policy rather than enabling public previews on this Worker.

This setting does not disable the production custom domain or deliberately change
`workersDev`. It also does not prove that previously uploaded previews or current
account settings have been updated: a repository edit is not a deployed policy.
The owner must apply the policy through the normal deployment process and resolve
any account-side preview settings that the version-upload path does not update.
Do not treat the old PR #17 or a successful version upload as evidence that
existing preview endpoints are inaccessible.

## Production deployment versus version upload

The package scripts have different effects:

- `pnpm deploy` uses `cf deploy` to publish a production deployment.
- `pnpm deploy:version` uses `cf workers versions create` to upload a version;
  uploading a version alone must not be interpreted as deploying it to production.

For Workers Builds, the owner must select the intended production branch and
production deployment command in the Cloudflare account. Non-production branches
must not run the production deploy command. This document does not change account
settings or add credentials/automatic deployment workflows to GitHub.

A fix merged into main does not repair an older deployed Worker until the intended
version actually receives production traffic. Record the deployed version ID and
commit in the release/change record, not just an upload/build result.

## Sentry version correlation

`CF_VERSION_METADATA: bindings.versionMetadata()` supplies the running Worker
version. The installed `@sentry/cloudflare` SDK uses its `id` as the release when
no explicit `release` or `SENTRY_RELEASE` override is supplied. The generated Env
types infer this binding directly from `cloudflare.config.ts`; no generated file
needs a hand-written binding declaration.

Version correlation applies to newly deployed code and newly captured events.
It does not backfill old events, upload source maps, create GitHub deployment
records, or automatically apply the same policy to other Workers. Source-map
publication needs a separate release process if readable production stacks are
required. Local environments without metadata should not invent a release ID.

## Monitoring and merge-policy follow-up (owner actions)

These controls remain outside the repository patches:

- Create a Sentry alert routing actionable errors to a real owner; a captured event
  with no alert rule is not incident detection.
- Configure external availability monitoring for both `/mcp` and `/infra/mcp`.
  Monitor an MCP initialize exchange and representative read-only tool calls,
  not the root redirect alone. Tool failures can appear in successful HTTP
  responses; inspect the MCP result for `isError` and validate expected content.
  Fetch-free tool registration means a successful initialization alone does not
  demonstrate that page feeds, AI Search, topology, or Worker Loader are healthy.
- Establish a repository merge policy before enabling dependency automerge:
  protected main, required reviews/checks selected by the owner, and a functioning
  gate. The explicit no-automerge rule proposed in #19 remains useful until then.

No live account policy, monitoring configuration, or deployment state is asserted
by this document. Do not paste telemetry credentials into PRs or monitoring URLs.
