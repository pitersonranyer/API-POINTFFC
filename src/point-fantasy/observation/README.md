# POINT Fantasy — official observation (3B.2)

This module has no controller, scheduler or bootstrap hook and is not imported by AppModule.
It never computes team scores, substitutions, final states, publications or rankings.
Only the four new observation tables are written. Traditional Cartola services are not called.
Direct GETs use the official canonical `https://api.cartola.globo.com` host; the legacy
`api.cartolafc.globo.com` returned a redirect to it during development verification. Unexpected redirects are refused.

## Manual development collection

After the reviewed migration and build, with the existing local `.env`:

```powershell
npm.cmd run fantasy:observe -- 2026 31
npm.cmd run fantasy:observe -- 2026 31 11111111-1111-4111-8111-111111111111
```

Season and round are required. Supply the same UUID to inspect/retry the same operation without another HTTP attempt.
A different observation requires a new UUID. The script refuses remote MySQL and NODE_ENV=production.
It instantiates only PrismaService, the direct public source and ObservationService; never the application.
Failures are recorded and printed as sanitized codes. Review `estado`, not just the shell exit code, for provider failures.

Summary: operation, collection, state, snapshot/version, shortened hash, record/coach counts, created/reused and limitations.
No payloads, connection URLs, user data or credentials are printed.

## Identity and observations

The round row records the **requested** season/round. A collection is an observation against that request, not proof of source identity.
Current snapshots require matching current season/round in market evidence before/after, unchanged market state,
matching payload round and, if provided, matching payload season. All retain provider-cache/completeness limitations.
This is contextual identity for observation, not final validation.

Earlier rounds use the numbered route and retain raw responses/evidence as IDENTIDADE_PENDENTE, without a snapshot:
the known historical payload has no unambiguous season identity. No image paths or filenames establish season.
Future phases may introduce a separately validated historical identity policy.
Current and numbered routes are never tried as interchangeable fallbacks.

Positive/zero/negative Decimal(38,18), original numeric tokens and raw JSON are retained without rounding.
Absent/null/value states apply independently to club, position, points, participation and scouts.
Observed false is never definitive absence. Omitted athletes have no synthetic rows.
Scouts are canonical decimal strings; the raw source remains available separately.

## Canonical representation

Strict duplicate-key-rejecting JSON parser retains numeric tokens before Number conversion.
Depth limit 64; payload limit 8 MiB; at most 10,000 athlete records; Decimal overflow/scale loss rejected.
Athletes sort by numeric ID and scouts by exact code. Decimal values use non-exponential canonical strings.
Semantic SHA-256 includes source, requested context (only after identity policy), normalizer and field states/values.
Timestamps, HTTP headers, transport endpoint, nickname and photos do not affect semantic identity.
Payload SHA-256 covers the UTF-8 decoded response text, before parsing (not compressed wire bytes).
Identical observations reuse a snapshot; A → B → A reuses the original A. New normalizers have distinct identity.

## Concurrency and recovery

Serializable short transactions, per-round row lock, DB UTC 120-second lease, UUID owner and monotonically increasing fence.
No HTTP inside a transaction. Four direct requests have separate 15-second timeouts; no heartbeat or automatic polling.
If delayed beyond the lease, the attempt cannot create an authoritative snapshot, even if no newer worker has arrived.
Evidence may still be attached to its interrupted attempt, never to a newer operation.
Operation UUID is globally unique and conflicting requested contexts are rejected.
Versions allocate via the locked round counter; snapshot content is insert-only in this service.

Expired in-progress operations are marked interrupted when explicitly retried or a new observation acquires that round.
A crashed process before storing its response cannot recover bytes it never committed; retry with a new UUID.
Persistence errors leave the operation recoverable rather than falsely reporting success.
Direct database writers are outside logical immutability; no destructive triggers or traditional-table changes are introduced.

## Local migration rehearsal

`scripts/point-fantasy-observation-db.cjs` is a phase-specific tool, not an application lifecycle hook.
`prepare` requires local MySQL, checks baseline drift against main, creates a full mysqldump backup in OS temp,
generates the four-table additive migration with CHECKs, creates a uniquely named isolated test schema and applies migration history there.
`test` runs observation suites only against that isolated schema. Fixtures are retained; no DROP/TRUNCATE/reset/deletes.
`apply` requires successful rehearsal, unchanged destination, migration hash, history, baseline drift and preserved-table checksums.
It applies local migrations and compares existing table checksums afterward. State resides in OS temp; do not share it as a credential file.
The test schema and backup are deliberately retained for inspection. A backup restore was not automated.

No new publication, validation, competition configuration or frozen-lineup tables belong to this phase.
Future publication FKs, completeness policy, legacy competition handling and decimal interpretation remain deferred.

## Execution evidence — 2026-10-19

- Branch: `feat/point-fantasy-scoring-observation-3b2`, from updated main `fc8b207`.
- Migration: `0028_point_fantasy_scoring_observation`, rehearsed in an isolated schema and applied to existing local MySQL 8.0.25.
- Baseline drift check passed. Full SQL backup retained under OS temp; prior-table checksums unchanged after migration.
- Isolated observation suites: 51 passing tests. General suite: 104 passing suites / 2,431 tests; 14 suites / 106 tests skipped.
- Prisma validation/generation, lint, typecheck and build passed. The transport suite was rerun after canonical-host correction.
- Local real collection 1 retained a transport failure from the legacy redirect (no snapshot).
- Collection 2 created snapshot 1/version 1: 275 records including 20 coaches; semantic hash prefix `7814e96f55e7`.
- Collection 3 reused snapshot 1. Retrying collection 2's operation UUID returned collection 2 without another request.
- No snapshot content was updated/deleted. No traditional processing, ranking, publication or closure was invoked.
- Isolated schemas and backups remain retained; no reset or destructive cleanup was executed.
