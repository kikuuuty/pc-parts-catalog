# Category FTS production transition — 2026-09-18

## Read-only discovery / target

Production DB `180175e0-edc0-49df-a9d7-5958d5982e8f` has migrations
0001–0006, **29,599 active products / 9 categories**, global `product_fts`,
normalizer 1. **0007, 0008 and 0009 are all unapplied**.
Latest complete sync is `3c0124cc-50a8-409f-9b39-219a4979a5c4`, source
`43356d620fcdfcad6bacaa64e1af18750b2f675f`.
Worker `812aa964-abfe-4de4-94db-228385cfcf2e` serves 100%, tag
`release-bffa78d9999ac48f234977e11e3b36cf`, actual epoch
`sync-3c0124cc-50a8-409f-9b39-219a4979a5c4-fts6-cache1`.
The checked-in epoch is stale; live management state is authoritative.
No sync lease, local identifiers or local enrichments exist at discovery.

Target: fixed BuildCores `eec0df175504ebd15f0f3e3a8249a18a22f00940`,
48,134 products / 30 categories, migrations 0001–0009, category FTS generation
8, cache/API generation 3, detail and resolve, current keyword/cursor semantics.
This intentionally publishes the fixed validated snapshot, not the newer
production source revision. Source differences are reconciled by normal ingestion.

## Compatibility decision (before any production write)

**Strategy C: one isolated D1, then promote its binding with the final Worker.**
0008 drops `product_fts`; the deployed Worker requires that table. In-place
migration while it serves requests is incompatible. A short window (B) cannot
remove that risk. A dual-schema intermediate Worker (A) adds unnecessary code.

The retained D1 is never migrated/deleted in this transition. Each old Worker
version retains its old DB binding; the final version binds the validated new
DB. Version propagation therefore never pairs the old code with deleted FTS.
The isolated database is used for the full benchmark before promotion. Its
public staging Worker is a separate script/rate-limit namespace. No production
benchmark is used to discover budgets. Staging did not exist at discovery.

Existing numeric IDs are seeded from the read-only production identity backup;
content hashes are marked for rebuild **only on the isolated DB**, so normal
ingestion reconstructs every raw/spec/identifier/facet/FTS record. New products
use the preserved ID high-water mark. Any local overlays or non-BuildCores /
inactive records cause the seed tool to stop for explicit reconciliation.

## Exact release order / automatic preflight

1. `node scripts/production-transition.js capture`: save management state,
   migrations, all sync metadata, sources, full product identity rows, local
   overlays and bounded current HTTP behavior to `.cache/transition-before.json`.
   Record Git release identity; confirm no Actions writer is active.
2. Create a separate APAC D1. Configure only its staging binding. Apply migrations
   0001–0009 there. Set `CLOUDFLARE_D1_DATABASE_ID` explicitly for administrative
   staging commands; the seed/sync tool refuses the retained production UUID.
3. `node scripts/production-transition.js seed`, then `sync` using the fixed
   local snapshot. Initial limit 50,000 changed products / 5,000,000 row writes.
   Partial/failed ingestion stops promotion; resume via hashes only after state
   inspection (do not blindly repeat seed).
4. `node scripts/production-transition.js integrity`: exact migrations, FK,
   quick_check, 30 FTS counts/projections, typed specs, raw, sync state, all
   existing IDs and product ID sequence. Run independent source integrity,
   seven-intent full UX benchmark, plans, full cursor traversal; compare local.
5. Deploy a staging Worker with distinct namespaces and target epoch. Verify
   HTTP correctness, shared builds, identifiers, caching and latency. Derive
   intent budgets with headroom from repeated remote runs. Run `npm run check`.
6. Before promotion, recheck live Worker version, latest sync, identity/local
   data and no active workflow. Any drift stops the transition and requires
   refreshing the isolated catalog. Set repository D1 UUID variable to the new
   binding: old default-branch release code must fail its config guard before
   writing/deploying. Publish matching code/config through the normal repository
   workflow before automatic scheduled releases can resume.
7. Hold the retained DB release lease and target DB release lease during binding
   publication. Recheck readiness/source/plans/budgets. Generate a complete
   production config with the new DB and `sync-<id>-fts8-cache3` epoch. Wrangler
   dry-run, then deploy final Worker at 100%. Capture previous/new version/tag.
8. Reconcile actual live version, DB binding and vars. Run bounded production
   HTTP smoke and read-only release verification, including representative
   seven-intent budgets, cursor, detail/resolve and multi-category shared build.
   Recheck unchanged sync/version; release leases. Persist all reports.

## Stop / recovery policy

Any migration, integrity, query-plan, severe performance or compatibility failure
stops promotion. Prior to binding publication the old API remains available and
the old DB is unchanged. Report isolated partial state and inspect before retry.
After a deploy transport error, read the live version/binding before another write.
After publication failure, report the live version, API health and database state;
do not attempt SQL down migrations or delete either DB.

Recovery is a Worker version rollback to
`812aa964-abfe-4de4-94db-228385cfcf2e` **with its retained old DB binding/epoch**,
after confirming that the retained DB remains intact and no newer writes need
reconciliation. Verify the selected version's bindings before execution. No
automatic destructive rollback is allowed. Until verification completes, no
catalog sync/enrichment is allowed against either database except the lease.

Full D1 SQL export is not assumed to support FTS5. The strongest immediate
recovery asset is the untouched original D1 plus the immutable Worker version.
The private `.cache/transition-before.json` captures local-only data (currently
zero) and ID mappings; keep it with release artifacts, not in Git. Historical
source commit + migrations 0001–0006 + the old normalizer/sync checkout rebuild
the old logical catalog. The target fixed source + migrations 0001–0009 + sync
rebuild the new catalog; restore identity mappings/overlays before publication.
Retain source checkout/notices and hash/versioned release artifacts. Recovery
does not depend on a successful FTS export or an untested Time Travel operation.

## Verification load and diagnostics

Full 233 search cases + 30 detail + 4 resolve cases and full cursor traversal
belong on staging. Production uses a fixed representative subset and paced HTTP
requests (respect Retry-After); integrity reads are bounded by the catalog size.
No synthetic product mutations on production. Remote diagnostics are read-only
and must use the matching source commit and explicit target UUID.

Execution outcomes and budgets are recorded below after measurement; this
runbook alone is not evidence of a successful release.

## Staging execution evidence / migration transport recovery

Isolated APAC/SIN D1: `pc-parts-catalog-fts8`, UUID
`0d64ee1a-6ead-4bfd-9dfd-91535e5b3030`. Worker:
`https://pc-parts-catalog-staging.kikuuuty.workers.dev`.
`wrangler d1 migrations apply` applied 0001–0007 but D1's `/query`
multi-statement transport rejected 0008 with `incomplete input`. Read-back
confirmed rollback (no new objects/history). An attempted array request was
rejected with HTTP 400 and made no changes. `wrangler d1 execute --file
migrations/0008_category_fts.sql --env staging --remote` then imported all **221
statements**, 138.1412ms, 218 rows written. All created schema definitions were
compared against the generated migration before recording history. 0009 was
bulk-imported with its history INSERT in the same file. No migration SQL or
search semantics were changed. `scripts/migrate-isolated.js` uses bulk import
with history included for future reproduction and rejects the production UUID.

The initial full sync hit the harness's 20-minute timeout at 44,900 committed
products. Process inspection confirmed no remaining Node writer. Only that
isolated run's lease was expired explicitly; normal hash-based sync resumed the
remaining 3,234 products. Historical interrupted run is retained as failed.
Final complete sync `dc3cb03f-3361-4bb4-a5c6-3584260cdb79`: **48,134 active**,
30 categories, zero deletions, 29,599 prior IDs preserved, sequence=48,134.
Source comparison checked all 48,134 raw/spec/identifier/facet/product records:
PASS. Foreign keys/quick_check/30 FTS projection and membership: PASS.

Two full remote runs: **236 search + 30 detail + 4 resolve = 270 cases** each,
failure=0, catalog full scan=0, 45 plan checks PASS. (Earlier docs saying 233
search cases predate the three extra UX fixtures.) Local and remote intent
rows_read quantiles agree exactly. 268/270 case plans/row costs agree; two fan
queries choose the typed `fan_size_airflow` index remotely instead of a PK
membership probe: `p2-fan-corsair120` 1,384→2,968 rows, `p2-fan-arctic140`
885→1,317. Both are bounded indexed category candidates, retain identical
correctness, and pass the remote budget. This is an observed planner/statistics
difference, not a claim of identical plans. No algorithm adjustment is needed.

## Official performance budget

`production-performance-budgets.json` is the release gate default; an explicit
`PERFORMANCE_BUDGET_FILE` can select a reviewed replacement. Budgets cover the
first UI page, whole four-query detail operation and whole one-query resolve.
Every pagination page also receives the intent's maximum safety ceiling.

|Intent|Cases|Local/remote rows median / p95|Remote SQL median (run 1 / 2), ms|Remote SQL p95 (run 1 / 2), ms|Rows p95 budget|SQL p95 budget, ms|Max rows / SQL ms|Queries median / p95|
|---|---:|---:|---:|---:|---:|---:|---:|---:|
|lookup|111|15 / 301|4.87 / 5.55|13.48 / 14.44|650|45|3000 / 150|1 / 1|
|identifier|18|22 / 58|4.82 / 5.21|10.65 / 15.87|125|50|150 / 150|1 / 1|
|browse|66|693 / 6987|7.46 / 8.96|28.72 / 26.32|14000|90|45000 / 200|1 / 1|
|browse_filter|28|481 / 9469|6.52 / 7.18|26.81 / 21.59|19000|85|32000 / 180|1 / 1|
|filter_only|13|1369 / 6334|3.19 / 3.84|14.97 / 11.93|13000|50|14000 / 150|1 / 1|
|product_detail|30|11 / 21|1.14 / 1.45|1.87 / 4.16|50|15|60 / 50|4 / 4|
|product_resolve|4|36 / 190|1.19 / 1.03|2.16 / 2.67|400|10|420 / 30|1 / 1|

Rows have about 2× rounded headroom; per-case maxima prevent an individual
outlier hiding below p95. SQL p95 has roughly 3× headroom against the worse of
two runs (larger absolute floor for tiny operations); latency is noisy and not
an equality check. Missing cost metadata, full catalog scans and indexed-plan
failures always fail independently. Query counts are capped at 1 (detail 4).
HTTP latency is reported separately including cache state and network transfer;
it is not substituted for D1 SQL duration or compared as equivalent to local D1.

Production bounded gate selects 11 search fixtures (CPU/compact lookup, two
source identifiers, MAG/Meshify browse, two filtered browse, board/memory/empty
filter), all 30 detail categories and four batch sizes. Exact source/integrity
reads remain full catalog checks. Full cursor equality is checked on staging;
production HTTP reads first two pages and a validated deep tail. Both profiles
retain quality and budget checks; the full suite remains the normal automation
default. CLI: `npm run release:verify -- --representative`.

## Production publication result — PASS

**Frontend consumption is enabled now at
https://pc-parts-catalog.kikuuuty.workers.dev.**

- Active Worker: `d644b54a-e35e-4389-a979-b0272b4a0905` (100%).
- Release tag: `release-b9b54959cbe94b1e22266c4502afd2ce`.
- Production DB: `pc-parts-catalog-fts8`,
  `0d64ee1a-6ead-4bfd-9dfd-91535e5b3030`, APAC/SIN, 219,578,368 bytes.
- Epoch: `sync-dc3cb03f-3361-4bb4-a5c6-3584260cdb79-fts8-cache3`.
- Source: `eec0df175504ebd15f0f3e3a8249a18a22f00940`, normalizer 1.
- Existing 29,599 numeric IDs preserved, 18,535 new identities; 48,134 total.
- Migrations 0008/0009 recorded at 2026-09-17 15:24:57 / 15:25:01 UTC
  (2026-09-18 JST). Prior live D1 remains generation 6 as the recovery copy.
- Both release leases were held through deploy and verification, then released.
  Final `sync_lock=[]`, FK violations=0, quick_check=`ok`, local overlays=0.
- The staging Worker was deleted after promotion; its binding was removed from
  `wrangler.json`. **That database is now production, not a benchmark sandbox.**
  Full transition tools reject production; provision a new isolated DB for
  another staging experiment. Retained old production D1 was not deleted.

### Required outcome checklist

|#|Requirement|Observed result|
|---:|---|---|
|1|Previous production|9 categories / 29,599 active, 0001–0006, global FTS, old snapshot/version above; Detail returned 404|
|2|Staging/remote|Dedicated APAC D1 and separate Worker/rate namespaces before promotion|
|3|Remote catalog|48,134 / 30 categories, exact fixed source snapshot|
|4|Seven-intent benchmark|Two full 270-case runs, failure 0 in every intent|
|5|Local vs remote reads|All intent median/p95 equal; 268/270 case plans/costs equal, two indexed fan differences recorded|
|6|Remote SQL duration|Two-run median/p95 table above; separate from network latency|
|7|HTTP latency|Staging and production table below, cache mix included|
|8|Intent budgets|Official JSON defaults applied; both full runs and production gate PASS|
|9|Compatibility|Strategy C; old code always retains old FTS/database binding|
|10|Runbook|Preflight → isolate/rebuild → full staging gate → leases → guarded binding publication → bounded production gate|
|11|Recovery|Retained old D1 + old Worker version; snapshot/identity/local overlay metadata captured; no destructive rollback|
|12|0008|221 statements imported and all created schema definitions reconciled; 30 FTS live|
|13|0009|Display-order indexes applied; migration history complete|
|14|FTS integrity|Missing=duplicate=wrong category=inactive orphan=projection drift=missing documents=0|
|15|Sync|Complete fixed snapshot, raw/spec/identifier/facet/source comparisons PASS; stable IDs and sequence PASS|
|16|Deploy|New version and binding confirmed through management API at 100%|
|17|Cache|Epoch formally rotated from fts6-cache1 to fts8-cache3; search MISS→HIT and Detail HIT; POST/resolve BYPASS|
|18|Health/categories|200 / available, exactly 30 categories; CORS preflight PASS|
|19|Lookup|CPU 9800X3D top1; GET/POST compiler parity PASS|
|20|Browse|Motherboard MAG returns candidates; source coverage gate PASS|
|21|Browse+filter|MAG + ATX + AMD B850 exactly matches 4 source products, no extras|
|22|Cursor|Staging 1,262/1,262, 26 pages, duplicate/missing 0, final cursor null; production first 100 + deep final 62 match and final cursor null; repeat order stable|
|23|Identifier|Real source MPN Hit@1; all 30 categories' keyword/identifier HTTP contracts checked|
|24|Detail|All 30 categories HTTP/direct equality; source/upstream_key/spec/facets/canonical identifiers present|
|25|Resolve|Single, multi, duplicate refs, order, active/missing PASS; batch sizes 1/12/32/64 pass direct gate|
|26|Shared build|CPU/motherboard/DDR5 memory/GPU/storage/PSU/case → refs → URL → parse → resolve → current IDs → Detail PASS|
|27|Production performance|Bounded 45-case seven-intent suite within all p95/max/query-count budgets; full scans 0|
|28|Production release gate|Full source integrity, 45 query-plan checks, 30 FTS readiness and bounded UX/detail/resolve PASS after deploy|
|29|Known issues|Cold Detail HTTP latency; sparse/source-conflicting identifiers; inactive has no safe production fixture; default-branch publication pending (below)|
|30|Frontend guidance|Use production origin, durable pair for storage, current ID for Detail, string identifiers, cursor reset on epoch change, respect 429/Retry-After|

### HTTP elapsed (ms; caller at NRT, including response body)

The staging run is representative repeated HTTP requests, separate from the
270-case direct-D1 benchmark. p95 in the small production smoke sample is a
diagnostic, not a population SLO. Pacing sleeps are excluded. All requests in
the measured smoke returned their expected success status; no retry inflation.

|Intent|Staging HTTP n|Staging median / p95|Production HTTP n|Production median / p95|
|---|---:|---:|---:|---:|
|lookup|11|109.57 / 356.75|8|106.95 / 142.83|
|identifier|5|112.88 / 127.58|2|100.95 / 107.54|
|browse|5|109.23 / 119.47|2|107.71 / 126.04|
|browse_filter|5|108.10 / 125.83|2|102.12 / 109.51|
|filter_only|33|119.98 / 140.51|8|113.87 / 125.35|
|product_detail|14|17.48 / 394.43|11|369.39 / 401.23|
|product_resolve|8|101.00 / 109.53|5|105.23 / 106.02|

Search GET and Detail samples mix HIT/MISS; all advanced search and resolver
requests bypass cache. Production Detail had 4 HIT / 7 MISS, while staging had
7 / 7: **the differing medians do not indicate a SQL regression**. Detail makes
four sequential indexed D1 calls; cold HTTP commonly costs ~370–400ms from this
location. Selection/loading UI should account for it. Optimization is outside
this migration. Search/detail cache identity includes API generation and epoch;
the pre-warmed old search namespace cannot be used by this generation.

### Correctness and price-provider readiness

Full lookup Hit@1=98.20%, Hit@3=99.10%, Hit@5=100%; all case-specific lookup
floors pass. Identifier Hit@1=100%. Browse mean relevant coverage=97.07%,
precision=98.23%, with four intentionally exhausted bounded windows; filtered
browse and filter-only have Recall=Precision=1, FP=FN=0. Product operations all
pass. Ordinary expected-empty filter cases are successful, not missing data.

Production `GET /v1/products/372` returns AMD Ryzen 7 9800X3D, including
MPN `100-100001084WOF`, EAN `0730143315289`, UPC `730143315289`, and other
source-provided alternatives/provenance. MSI MAG B850 TOMAHAWK WIFI returns
MPN `MAG B850 TOMAHAWK WIFI`, EAN `0824142447574`, UPC `824142447574`.
Samsung 990 Pro 2TB returns MPN `MZ-V9P2T0B/AM`, EAN `0887276657011`,
UPC `887276657011`. Values retain leading zeros and punctuation.

The adapter can call a price provider using `identifiers[]` now. Provider code
itself was not added. Canonical grouping is not a guarantee of source accuracy:
upstream may list multiple SKU alternatives, and the selected Biwin DDR5 kit
has an empty identifier list. Preserve `origin`, `origin_field`, `origins` and
region; providers must handle missing/conflicting identifiers and product names.
No JAN/GTIN values were invented or reclassified from EAN. Inactive behavior was
covered locally; production records were not mutated to manufacture a fixture.

### Automation, monitoring and remaining work

Repository variable `CLOUDFLARE_D1_DATABASE_ID` now equals the new production
UUID. An old default-branch config fails its existing mismatch guard before
sync/deploy. The local changes have **not been committed/pushed**: publishing
them to the default branch is the remaining step for scheduled releases to use
this generation. There is no new human approval gate. Until publication, the
live API is available on the fixed snapshot; old automated releases fail closed.

`npm run check`: 175/175 PASS after budget/binding updates. Diagnostics launched
with `--case cpu-9800x3d`, performed the local case evaluation on the identical
fixed source snapshot and returned zero failures. Use:

```sh
npm run diagnose:search -- --case cpu-9800x3d
```

The UI is loopback-only and local/read-only. Keep the local snapshot aligned
before investigating a later production sync. No remote write diagnostic was
added. Remote read-only verification remains `npm run release:verify --
--representative`. Worker observability/log configuration and request IDs,
`X-Cache`, `Server-Timing`, 429/Retry-After protection remain enabled.

### Artifacts

Private/raw evidence is under `.cache/transition-*.json`, especially:
`before`, `migrations`, `sync`, `integrity`, `ux-remote-1`, `ux-remote-2`,
`comparison`, `measurement-summary`, `http-staging`, `http-production`,
`promotion`, `production-gate`, `diagnostics`.
`.cache/release-deploy-report.json` contains the normal release pipeline result.
Keep these artifacts and `.cache/upstream` with the retained DB while recovery
is needed. The old source commit object is present in the local upstream Git
store; the working HEAD remains the fixed target commit. This document and the
budget JSON provide the concise tracked evidence without committing catalog data.
