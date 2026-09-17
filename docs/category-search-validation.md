# Local UX / pagination / reference validation

This checkout preserves category-specific FTS. The measurements below are local
D1/workerd (`miniflare.db`), **not remote latency or billing measurements**.
No production migration, sync, deploy or cache-epoch change was performed.

## Snapshot and commands

- Snapshot: `eec0df175504ebd15f0f3e3a8249a18a22f00940`
- Products: 48,134 active, 30 categories
- Existing local sync: `24fe3701-08c4-42d9-b873-1be29bd4d051`
- Node 24.16.0; Wrangler 4.131.1
- Local migration applied: existing 0008 category FTS and new 0009 display index
- Existing migration files 0001–0008 were not modified

```sh
npm run check
npm run verify:ux:local
npm run release:verify -- --local
node scripts/report-ux.js
```

`npm run check`: schema generation check passed; **171 tests passed, 0 failed**.
`verify:ux:local`: real Worker fetch handler + persisted local D1, with the
existing test-only limiter adapter. Memory DDR5/32GB: **1,262 products, 35 pages,
page sizes 17→37, 0 duplicate, 0 missing**, cursor replay passed. Shared-build
URL restored 32 references spanning 30 categories with **one SQL resolve**;
search/resolve/Detail identity agreed.

Offline integration tests additionally cover first/next/final page, changed page
size, deterministic NOCASE/NULL/empty ordering, custom typed sorting, cursor
corruption/version/category/filter/order/epoch rejection, inactivation and
removed anchor replay. Resolver tests cover active/inactive/missing, duplicate
input, order, max 64, malformed refs, unknown source, uncached behavior, and a
fresh DB giving the same stable ref a different numeric ID.

The optional `npm run diagnose:search` UI was also checked in Edge against local
D1: keyword search, typed filters, cursor pages, identifiers and score/plan display
passed. It has no approval inputs and does not send any judgment to release.

## Release outcome

**Release gate failed (correctly retained blockers):**

- human review blockers: **0**; review files are not read by release
- automated lookup quality: **2 failures** (`ext-mouse-03`, `ext-headphones-03`, Hit@3)
- candidate quality: **22 failures** (21 browse, 1 browse_filter)
- source integrity: pass, raw/spec/identifier/facet/category/active comparison
- FTS integrity: pass; missing/duplicate/wrong-category/orphan = 0
- identifier: 18/18 Hit@1; source owners supply equivalent sets
- filter_only: 5/5 exact equality, complete cursor traversal and stable ordering
- Product Detail/reference checks: pass
- performance metadata / safety ceilings / full-scan gate: pass
- representative query plans: **45/45 passed**; all seven intents have 0 catalog
  full scans. Typed retrieval uses indexed candidates then stable display sort;
  listings use `products_display_order`; resolver uses source/key unique index.

All 111 lookup cases are machine evaluated, regardless of human review. The
current total is **24 automated quality failures**, with no human sign-off needed.
Source-derived expectations were not expanded to cover returned contaminants.
The 21 browse failures comprise precision failures for
`memory-trident-series`, `p2-gpu-5070-12gb`, `p2-gpu-9060xt-16gb`,
`p2-storage-samsung2tb`, `p2-board-b650e`, `p2-board-am5-atx`,
`p2-board-b650-matx`, `p2-board-asus-am5`, `p2-case-meshify`,
`p2-fan-noctua120`, `p2-fan-bequiet140`, `ext-keyboard-09`, `ext-monitor-09`,
`ext-headphones-09`, `ext-sound_card-05`, `ext-thermal_compound-05`, and coverage
failures for `p2-psu-850noun`, `p2-cooler-360aio`, `p2-cooler-360mmaio`,
`p2-cooler-240aio`, `p2-fan-120noun`. The browse_filter failure is
`p2-storage-sata1tb`.
The ten UX reclassifications have **8 passing and 2 failing** cases:

|Case suffix|Intent|Relevant/returned|Result|
|---|---|---|---|
|storage-990-2tb|browse_filter|2/2|pass|
|storage-sn850-2tb|browse_filter|2/2|pass|
|storage-sn850-4tb|browse_filter|2/2|pass|
|storage-990-1tb|browse_filter|2/2|pass|
|storage-sata1tb|browse_filter|130/128|FN=2; recall 98.46%, precision 100%|
|board-b650e-wifi|browse_filter|12/12|pass|
|case-meshify|browse|5/57|FP=52; coverage 100%, precision 8.77%|
|case-matx|filter_only|609/609|pass|
|case-itx|filter_only|336/336|pass|
|cooler-freezer360|browse_filter|15/15|pass|

See [before/after and UX reasons](search-evaluation.md#ten-old-browse-failures-frontend-operation-rationale).

## Per-intent local cost

Nearest-rank quantiles across cases, first UI page (50+1 rows); Detail sums its
four statements. Resolve samples contain 1/12/32/64 refs. These are safety
measurements, not adopted production latency budgets.

|Intent|Cases|rows_read median / p95|SQL ms median / p95|queries median / p95|
|---|---:|---:|---:|---:|
|lookup|111|19 / 370|3 / 7|1 / 1|
|identifier|18|22 / 58|3 / 5|1 / 1|
|browse|77|846 / 6,987|5 / 14|1 / 1|
|browse_filter|22|430 / 9,425|4 / 9|1 / 1|
|filter_only|5|5,187 / 7,403|6 / 6|1 / 1|
|product_detail|30|11 / 21|1 / 2|4 / 4|
|product_resolve|4|36 / 190|1 / 1|1 / 1|

Snapshot series values: 16,349 NULL, zero empty string. Manufacturer: 58 NULL.
Sorting semantics explicitly handle both NULL and stored empty strings.

## Artifacts and remaining work

- `.cache/release-ux-report.json`: full case metrics, source integrity, plans,
  fixture hashes, failures and all-page costs
- `.cache/release-verify-report.json`: release stop phase, FTS pass, no deploy
- `.cache/ux-api-local.json`: cursor/shared-build local API checks and D1 events
- `npm run benchmark:ux`: repeatable local or explicitly selected remote
  measurement, independent of gate pass/fail

Before production: resolve the 24 automated lookup/candidate quality failures;
stage/measure remote D1 and set seven-intent budgets;
separately authorize/apply migrations 0008/0009 as needed and release with the
derived epoch. Local correctness and local timing do not substitute for those
steps. [Release procedure](catalog-release.md).

The former keyword-free large OFFSET window, Top20 browse gates and all mandatory
human review/approval requirements are removed. The historical
extended evidence manifest is retained as source-authoring provenance, not as a
runtime review policy. Frozen source fixtures and migration history are intact.
