# Catalog sync → production release

## Architecture / safety boundary

`.github/workflows/sync.yml` runs the complete release on the reviewed default
branch. Weekly: Monday 03:17 UTC (12:17 JST); manual: `workflow_dispatch`.
The existing `catalog-production-sync` concurrency group covers the **whole**
workflow, with `cancel-in-progress: false`.

```text
npm ci → npm run check (schema generator + npm test)
  → pin immutable upstream commit; save artifact BEFORE any catalog writes
  → validate entire upstream snapshot / migrations / count envelope
  → existing syncSnapshot (hash resume / deletion guard / write budget)
  → require complete + exact active counts from validated snapshot
  → acquire existing D1 sync_lock as release lease
      → readiness / integrity / FTS / schema
      → verifyPlans + benchmarkSearch with fixed Golden acceptance
      → recheck snapshot / renew lease
      → derive epoch + generate production config + Wrangler dry-run
      → reconcile live Worker version/tag/vars → deploy if needed
      → production smoke + cache + public contract + 120 Golden API/direct
      → confirm Worker version / catalog unchanged
  → release lease; summary + artifacts
```

`scripts/catalog-release.js` orchestrates the existing sync, model, database,
quality and search implementations. `scripts/worker-predeploy.js` is the
read-only readiness entry point and shares the same gate implementation.
There is **no migration** for this automation. Scheduled releases check migration
history; schema changes must be reviewed and applied separately.

**Fail-closed means no Worker upload/deploy before all gates pass.** A failed
post-deploy check marks the release failed and never reports it as healthy.
It cannot prevent traffic that already reached the newly deployed version.

The existing catalog is updated **in place**, one atomic ingestion chunk at a
time. Retaining the old Worker does not retain the old D1 snapshot. During sync,
or after a partial/quality failure, uncached searches can see changed products;
old cache entries expire within their existing TTL. This pipeline does not claim
atomic catalog publication or automatic data rollback. Strict isolation would
require a later staged/dual-catalog design. The release lease prevents the normal
sync writer from changing the candidate during quality/deploy/verification.
Manual SQL, enrichment writes, migrations and raw Wrangler deploys must also be
kept outside this release window; they do not all participate in `sync_lock`.

## Triggers / credentials

|Setting|Purpose|
|---|---|
|Secret `CLOUDFLARE_API_TOKEN`|Existing name; target account **D1 Edit + Workers Scripts Edit**, including Worker version/deployment reads. Never install this in the Worker.|
|Secret `CLOUDFLARE_ACCOUNT_ID`|Existing name; must equal root `wrangler.json.account_id`. Config fallback also works.|
|Variable `CLOUDFLARE_D1_DATABASE_ID`|Existing optional override; if set, must equal the production `DB` UUID.|
|Built-in `GITHUB_TOKEN`|`contents: read`, `actions: read`; snapshot artifact download. No additional PAT.|

No cache epoch secret/variable or automatic Git commit is needed. Repository
settings were checked during implementation: repository secrets and variables
lists were empty. Configure the token/settings before enabling the merged
workflow. Local Wrangler OAuth was used for the implementation's remote checks;
this does not configure GitHub Actions credentials.

Manual inputs:

- `upstream_ref`: default `main`, resolved once to a 40-character commit.
- `max_products`: default **10000**, changed/deleted products per run.
- `write_budget`: default **2000000** D1 row writes per run, for current Paid
  production. This is a conservative chunk allowance, not a daily quota tracker
  or a strict upper bound on Cloudflare billed writes. The ordinary `sync` CLI
  retains its original 1000/80000 defaults.

Budget exhaustion produces `partial` and a **failed workflow**, with no deploy.
There is no unbounded sync loop or automatic daily quota reset retry.
Initial empty imports are not the scheduled production-release path.

## Epoch and configuration

```text
sync-<completed sync_runs.id>-fts6-cache1
```

- `sync_id` identifies a successfully completed catalog import. A workflow retry
  compares actual D1 product hashes under the writer lease and reuses that ID if
  the same upstream commit/normalizer is complete with no changed/deleted rows.
- FTS generation `6` corresponds to migration 0006 and the canonical projection.
  Generation changes require a reviewed forward migration and gate update.
- `cache1` comes from the existing `v1` Cache API schema namespace, now exported
  as `CACHE_SCHEMA_GENERATION`. The cache key format and admission policy are
  unchanged. Response/search semantic changes require a reviewed schema bump.
- Same snapshot + same generations = same epoch across retries/deploys.
  Workflow run IDs, attempt counters and wall-clock time are not epoch inputs.
- A new completed import (including a different upstream commit) gets a new ID.
  Out-of-band identifier/data mutations are outside this identity protocol and
  need an explicitly recorded completed sync and release before cache reuse.

The root-level `.catalog-release-<uuid>.json` is a temporary copy of the complete
production Wrangler config. It changes only `vars.CATALOG_CACHE_EPOCH`, removes
the `env` map, and retains relative paths, TTL, D1, rate-limit bindings and other
production settings. It is ignored by Git and deleted in `finally`.
Wrangler always receives `--config <file> --env ""`; no local config selection.

[Wrangler deploy documentation](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)
was checked against pinned Wrangler **4.131.1**. `--var` can override config
values, while normal deploy treats config vars as authoritative and can remove
Dashboard-only vars; `--keep-vars` retains unspecified remote vars and secrets
are always preserved. We use a complete config rather than a partial CLI var
override or environment-only substitution, and reject undeclared remote
plain-text/JSON vars before deploy. After deploy the management API must report
all expected var values. A missing TTL cannot silently become a successful gate.

`release-<sha256 prefix>` Worker version tags hash production config (with the
derived epoch), `src/` contents and `package-lock.json`. If the active 100% version
already has that tag and expected vars, skip uploading another version and run
post-deploy checks again. A transport failure after a successful deploy therefore
does not force a duplicate Worker update on retry. The checked-in historical
epoch is not the runtime source of truth for this path and is never rewritten.

## Quality gates

1. Exact local migration-name set equals D1 migration history; unexpected newer
   schema also stops an older checkout.
2. Latest sync is complete with finished timestamp and current normalizer.
   No running sync anywhere, residual foreign lease (even expired), staged ingest,
   FK violation, or `PRAGMA quick_check` error. Historical failed/partial records
   remain audit history; only a later complete sync supersedes them. They are
   never deleted merely to pass a gate.
3. Active count **20000–100000**, all nine categories nonempty; the sync path
   requires exact per-category equality with the fully validated upstream.
   Before writes each existing category's snapshot count must be 80–150% of the
   current count. The existing per-category 20% deletion guard also applies.
4. Required model columns/spec rows; FTS columns, projection view/ingest trigger,
   canonical field equality, missing and orphan FTS documents.
5. `schema:check` checks generated migration/model agreement. It is cheap and
   also runs for a direct script invocation.
6. Existing `verifyPlans()` (currently 37 cases) must pass. Existing
   `benchmarkSearch()` must pass the fixed 120-query acceptance below.

The ordinary benchmark CLI intentionally measures low scores without failing.
The **release gate** adds explicit failure conditions. Golden fixture SHA-256 is
fixed to `68d4f73da2ba143c06b5307cd84b97cb232db6489fbcee77b94e9974d925bfb7`.
The [recorded Phase 2 result](search-quality-phase2.md) supplies per-query floors:
rank ≤1 except `gpu-gaming-x-trio5080` ≤4 and `p2-case-matx` ≤2; all queries HIT.
For explicit acceptable sets, P@5/P@10 ≥1/1 except the documented case queries
(0.6/0.7, 0.6/0.8) and B850 WiFi (1/0.9). Improvement elsewhere cannot offset one
query's regression. Fixtures, expected products and ranking are not rewritten.
New catalog data can legitimately change top-20 ordering; accepted relevance
must meet these floors, and the deployed API's actual top-20 must equal direct
search on the candidate. This is not a frozen historical top-20 catalog policy.

`npm run check` includes **`npm test`**; the workflow runs it once. Plans and full
Golden quality run once under the release lease, followed by lightweight state
rechecks. Post-deploy Golden is a separate HTTP/compiler equivalence check.
CI's pinned local catalog uses `release:verify -- --local` instead of duplicating
the full benchmark and plan commands. Local HTTP integration remains
`npm run verify:worker:local`.

## Production verification

`verify:api --smoke` and the release pipeline share
`scripts/lib/production-smoke.js` and consumer assertions in `api-contract.js`.

- Health / categories / CORS preflight / unsupported method / invalid limit.
- Exact model, manufacturer+model, spec and broad search: 200 JSON,
  stable product IDs, public fields, specs object, attribution, returned/limit,
  has_more and pagination/window fields; GET/POST full body equality.
- Second page and window boundary; direct SQL lookahead/top-result equivalence.
- Cold standard GET: **MISS + D1 Server-Timing**, then same-POP **HIT without D1
  timing**, valid Age and exact body equality with uncached POST.
- All 120 existing Golden queries via actual GET/advanced POST versus current
  remote direct top-20; no public ranking/debug fields.
- Same completed sync and active Worker version/vars after verification.

Requests are sequential, at least **3.5 seconds apart**, including expensive
POST. 429/502/503/504 and transport failure get at most three attempts.
`Retry-After` is respected with bounded backoff (over 120s stops verification).
400/405 contract failures and nontransient failures do not become successful
retries. No production limiter is disabled or bypassed.

A first HIT cannot establish MISS→HIT. The probe tries at most six legal internal
whitespace variants of a representative DDR5 query, each checked against direct
SQL and POST. It does not add unsupported cache-buster parameters. Prewarmed
keys and different POPs are inconclusive and cause another probe; unresolved
conditions fail the verification. Same-POP MISS→MISS is a failure. Tests also
assert exact D1 call/log counts on HIT; production headers attest the existing
observable contract, not independently collected billing/tail metadata.

## Retry / failure recovery

|Failure|Behavior / recovery|
|---|---|
|Before pin artifact saved|No catalog writes. Start a new workflow if retry cannot restore the artifact.|
|Actions rerun / moving upstream main|Restore first-attempt `catalog-snapshot-pin` artifact; fail if missing/expired/wrong run. Never re-resolve main on retry.|
|Older run retried after a newer catalog|Pin records its base sync ID. Under the sync lease reject a different, superseding snapshot; start a new workflow.|
|Mid-sync / failed / partial|Stop before deploy. Wait for the 15-minute writer lease to expire if necessary; retry same pin. Existing committed hashes determine remaining writes. A recovered running record becomes failed history, then the resumed run must complete.|
|Sync complete, later gate fails|Completed ID/epoch reused. Fix cause, rerun; no product rewrite or artificial completed sync just for retry.|
|Golden fails|Stop. Investigate data/projection/expected target changes; no automatic baseline update or ranking changes. Recover a reviewed catalog or fix the defect.|
|D1 / Cloudflare temporary read failure|At most three administrative read attempts; sanitized error. Writes are never blindly replayed.|
|Release lease renewal fails|Fail closed before next phase. No deploy starts without explicit lease renewal. Lease is 900s, renewed every 60s; deploy subprocess is bounded to 120s.|
|Deploy response lost|Outcome is unknown. Inspect live version/tag/vars. Retry reconciles the live tag before deciding to deploy.|
|Deploy succeeds, smoke fails|Release stays failed, new version may already serve traffic. Investigate promptly using saved previous/new version IDs. Rerun verification or recover as below.|
|429 / cache race|Bounded paced recovery as above; unresolved checks fail. Never weaken rate thresholds.|

The completed pin is retained for 90 days; summary artifacts for 30 days.
Console/Step Summary includes phase, sync ID, counts, completion time, epoch,
Golden result, deployment status, previous/deployed Worker versions and smoke
result. Reports are `.cache/release-*-report.json`, with
`.cache/release-pin.json` and `.cache/release-snapshot.json` as state files.
No provider error bodies, SQL, query history, user data or token values are
logged/uploaded. Detailed inspection/benchmark/raw query artifacts are not
uploaded by the production workflow.

## Manual operation / rollback

Run from repository root on Node 24, using the same reviewed checkout and
production credentials. To deploy the **current complete** snapshot:

```sh
npm ci
node scripts/worker-predeploy.js
npm run worker:deploy
```

`worker:deploy` includes `npm run check`, full locked gates, epoch/config
generation, deploy and post-deploy checks. To check without any D1/Worker writes:

```sh
npm run release:verify -- --local
npm run release:verify
npm run verify:api -- --remote --url https://pc-parts-catalog.kikuuuty.workers.dev --smoke --golden
```

For a pinned manual sync, set `UPSTREAM_REF` to the reviewed commit (PowerShell:
`$env:UPSTREAM_REF = "<commit>"`; Bash: `export UPSTREAM_REF="<commit>"`), then:

```sh
npm run check
node scripts/catalog-release.js pin
npm run release:sync
npm run worker:deploy
```

For sync retry, retain `.cache/release-pin.json` and rerun `release:sync`; do not
run `pin` again with a moving ref. Review budgets before increasing them. Stop
scheduled/manual writers while doing recovery. Do not bypass gates with a raw
`wrangler deploy` or change a stale epoch in Git.

**Recovery has two independent parts: Worker code/config and D1 data.**

- For a code defect with a healthy completed catalog, prefer a reviewed known-good
  code checkout compatible with current migrations and this release procedure.
  It derives the **current catalog** epoch rather than resurrecting an old one.
- Emergency exact-version rollback uses the recorded previous version, e.g.
  `npx wrangler rollback <previous-worker-version> --env=""`. Verify its bindings,
  schema compatibility and epoch first. An old version also restores its old
  vars/epoch and can expose its still-live cache entries until TTL expires.
  Reconcile configuration and run smoke/contract checks after rollback.
- A Worker rollback does **not** undo sync. For partial/bad catalog, validate the
  intended pinned upstream and resume/recover using existing sync guards. A
  reverse sync can exceed the deletion guard; review the actual data delta
  rather than auto-relaxing it. Destructive DDL, database recreation and automatic
  Time Travel restore are not recovery actions in this pipeline.
- Automatic rollback is deliberately absent: HTTP 429/POP races or a temporary
  outage are insufficient evidence to restore an older schema/config/epoch.

## Consumer integration

The existing [API v1 document](cloudflare-production.md#api-v1) is the consumer
contract, including the new frontend integration quick reference. Product search
is read-only and public. It is not price/availability/compatibility validation.
`test/worker.test.js` protects the small public contract; production verification
uses the same independent assertions. Frontend-specific models are not added.

## Implementation verification record (2026-09-13)

- `npm run check` (includes `npm test`): **94/94 passed**; targeted retry tests passed.
- actionlint 1.7.7: both workflows passed (`-shellcheck=`; ShellCheck not installed).
- Existing local complete catalog: 29,599 active, 37/37 plans, 120/120 Golden
  acceptance, production config Wrangler dry-run passed. Also passed with
  `GITHUB_ACTIONS=true` to exercise the CI-only environment path without a
  production sync checkpoint requirement for read-only local verification.
- `verify:worker:local`: contract, MISS→HIT, POST body equality, 120/120 Golden
  HTTP/direct passed with rate limiters enabled.
- Remote read-only readiness / integrity / 37 plans / 120 Golden / dry-run passed.
  Completed sync: `34aa2c91-d6eb-448b-8ece-05f027a156c2`,
  timestamp `2026-09-13T03:31:03.283Z`, active 29,599.
- Pinned existing upstream `eec0df175504ebd15f0f3e3a8249a18a22f00940` and executed
  `release:sync`: **reused=true**, same sync ID/epoch. Only existing sync lease
  acquisition/release was needed; no product/FTS rewrite or new sync run.
- Initial pin/report filename collision was found before sync writes, fixed,
  and covered with an actual CLI artifact-retry regression test.
- `npm run worker:deploy` completed all locked remote gates and deployed Worker
  **`c121cf15-c15b-4a56-a9e2-bc115ab6edde`**, replacing
  `af26291a-eb53-410a-b22a-73a6cef5b49c`. The management API confirmed 100% traffic,
  release tag, epoch and TTL; same Worker version was confirmed after verification.
- Production **health/categories/GET/POST/CORS/pagination/attribution passed**;
  **MISS + D1 timing → HIT without D1 timing**, POST/full body equality passed;
  **Golden API/direct top-20 120/120 matched**. Release lease was acquired,
  renewed and released. No migration, product/FTS update, limiter change or
  rollback was performed.
- A final read-only readiness check after lease cleanup again confirmed the same
  complete sync, 29,599 active products, integrity and no residual lease.
- GitHub workflow dispatch/schedule was not executed: changes are in the working
  tree and repository Actions credentials remain unconfigured. Actual production
  validation used the same dedicated script via local Wrangler OAuth.

Contains information from [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db),
made available under [ODC-By 1.0](https://opendatacommons.org/licenses/by/1-0/).
