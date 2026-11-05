# Private warehouse cloud contract — 2026-11-05

Status: implementation contract, not a release claim. Owner: Astra. Baseline b6172c04170ff60a9f5e13ec8ad5cdd959e6094e plus preserved uncommitted source; backup E:\Project\Image2PinDouDesign-task-backups\cloud-20261105-191218. Branch codex/private-warehouse-cloud.

## Scope and ownership

User explicitly resumed development and deployment. Maximum two implementation sessions concurrently. No Oracle sessions. Workers must preserve other edits, stay within ownership, never commit/push/deploy, and return changed files, verification, residual risks and blockers.

- Terra: new pindou-hub/server/cloud/** including backend tests. No existing LAN server changes; no frontend, package manifests, deploy or shared docs edits.
- Sol: pindou-hub/web/src/{lib,components,pages} account/inventory/order integration and necessary frontend tests, main.tsx, App.tsx, web/vite.config.ts. Preserve recognition/generation/enhancement/stitch code. No server, package manifest, deploy or shared docs edits.
- Astra: this contract, dependency/package changes if necessary, deployment assets, integration and review. Consult before any protocol change.
- DeepSeek later: explicitly handed-off test/doc files after implementation ownership is released. Independent Sol review is read-only.

## Security and limits

Separate Node/SQLite WAL service, localhost only, independent data directory. Never expose LAN Hub or /api/local-token. No service-side image processing or cloud blobs. Initial cloud collections: patterns (metadata/counts only, no matrix/imageId/previewId), txns, prefs, orders. Local blobs and matrices stay local. Guest data never automatically migrates into an account.

Username/password login with recovery code: username 3–32 ASCII letters/digits/_/-, case-insensitive uniqueness; password 10–128 characters. Use Node crypto async scrypt with bounded concurrency, per-user salt, timing-safe verification, random session/recovery tokens stored hashed. Recovery rotates code and invalidates old sessions; password change invalidates other sessions. Secure HttpOnly SameSite=Lax cookie in production, Path=/cloud-api, bounded expiry. No secrets in logs. Origin must match configured origin on writes; require x-pindou-client:web. No wildcard CORS. All API responses private,no-store. x-pindou-account must match authenticated user on data APIs, never establishes identity. No user/warehouse selector can change scope. Auth rate/body limits and strict schemas mandatory.

Initial registration capped at 100 (configurable; registration can be disabled). 2MiB per account is a warning budget; configurable explicit hard ceiling defaults 4MiB for record payload, never silently delete. Whole service persistent data ceiling 300MiB; preserve >=1GiB disk free; reject growing writes safely with 507 when thresholds reached, retain read/export. Include database/WAL growth in health/ops evidence. No unbounded mutation log or session growth: bounded retention with documented retry expiry and safe conflict response rather than re-execution.

## HTTP protocol

Prefix /cloud-api. JSON errors {error:string,code?:string}; 401 expired/missing session, 403 account/origin mismatch, 409 revision/business conflict, 413 body/size, 429 throttling, 507 capacity. Stable account id is opaque string. Health reveals no user data.

- POST register {username,password} -> {user:{id,username},recoveryCode}; sets cookie.
- POST login {username,password} -> {user}; sets rotated cookie.
- GET me -> {user:{id,username}|null}.
- POST logout {} -> {ok:true}; revoke session and expire cookie.
- POST recover {username,password,recoveryCode} -> {user,recoveryCode}; invalidate sessions and old code, set new cookie.
- POST change-password {oldPassword,password} -> {ok:true}.
- GET state -> {revision,records:CloudRecord[]}; bounded full bootstrap/export compatible with initial small quotas. GET changes?since=N&limit=200 -> {revision,cursor,more,records}; bounded incremental changes/tombstones. Client must not mark a partial pull complete and must restart full bootstrap on invalid/expired cursor (409).
- GET export -> {app:"pindou-hub",records,revision}; only this account.
- POST mutate {mutationId,baseRevision,operation} -> {revision,records:CloudRecord[]}; returns authoritative changed records (not whole database). Exact successful request replay returns original result even when revision advanced; same id/different payload is 409. Dedupe scoped to account; check replay before baseRevision. Atomic commit of state, balances, revision and mutation receipt. Any failure rolls back completely.

CloudRecord = {collection:"patterns"|"txns"|"prefs"|"orders",id,data,updatedAt,deleted:boolean}. Server validates IDs, finite bounded numbers, counts, enum values, quantities and object shapes; rejects oversized nested payloads. Account ownership comes solely from session. Server timestamps are authoritative for committed changes. Legacy client timestamps never determine conflict winners.

Operation variants (exact field names):
- {type:"records",records:CloudRecord[]}: metadata/settings/order draft changes and ordinary purchase/adjustment txns. Txns immutable after creation except explicit tombstone/reversal handling with version protection. Cannot set order.received or pattern.consumed, cannot forge consume/stocktake records. Preserve protected existing business state. Deletes cannot erase received order identity and enable repeat receipt.
- {type:"receiveOrder",orderId}: saved order snapshot -> received plus generated inventory txns atomically. Repeated receipt with a new mutation id returns no additional stock. Reject deleted/missing orders. No partial receipt this release.
- {type:"completePattern",patternId,deduct:boolean}: done status, optional stock deduction atomically; already consumed cannot deduct again. Use stored counts/copies.
- {type:"stocktake",code,actual}: server computes difference from current balance after baseRevision check.
- {type:"import",records:CloudRecord[]}: explicit user-requested backup restore/guest migration; validate entire batch, stable IDs, no partial import; protect already-received/consumed identities and existing immutable txns. Must not provide a loophole to repeat receipt/consume or overwrite unrelated new server data. Conflict fails with actionable message. Export/import roundtrip includes orders.

Workers may propose a simpler safe import restriction if needed, but must report and obtain main-agent integration decision before changing this contract. Cloud destructive undo of received/completed business operations can be unavailable with clear copy; never implement partial undo. Preserve local-mode undo and existing behavior.

## Client consistency

Separate guest/account IndexedDB. Validate me before exposing account cache on startup; explicit offline account behavior, no misleading authenticated/synced status. On 401/403 stop sync and writes to that account, retain recoverable pending data, offer relogin/export. Cookie account switches across tabs must never deliver another account's data to local cache.

All account read-modify-write and sync operations use cross-tab Web Locks (safe fallback must block unsupported concurrent mutation, not silently use a page-only mutex), read fresh IndexedDB within lock, and notify other tabs via BroadcastChannel. Do not hold stale in-memory snapshots across lock boundaries. One durable pending mutation with immutable payload/id/base revision; persist before network. Response-loss retry reuses it; block subsequent dependent writes until resolved. Offline mutation may be queued with clear pending status; never claim cloud success. On definitive conflict preserve/export local work and require explicit resolution, never silently discard it. Unknown outcome must be retried before allowing discard. Disable conflicting UI actions and show errors. Incremental pull must not erase pending changes. Bootstrap/reload only replaces data after explicit safe resolution.

Local saved orders are snapshots, unaffected by later stock changes. Local receive and complete actions use one IndexedDB transaction and deterministic business identity under cross-tab lock. Backup import/export must include orders and be atomic. Keep image outbox semantics separate from cloud.

## Acceptance gates

Guest mode; register/login/logout/session expiry; two-account API, changes and export isolation including forged account headers; order snapshot and duplicate receipt; atomic complete/deduct; stale stocktake; same/different account cross-tab tests; two-device conflict; offline and committed-response-loss retry; orders backup roundtrip; strict schema/quotas; backend and relevant frontend tests; existing regression/build; real-browser checks. Independent read-only Sol reviews security/concurrency/regression/deployment, fixes are retested before release.

Production: recheck 102 hostname/disk/memory without touching unrelated services; isolated localhost service behind exact /cloud-api routing, /warehouse static app, no LAN exposure, private cache policy. Build locally. Consistent off-host backup and restore drill, rollback plan, minimum 1GiB free and 300MiB business ceiling. Record real measured limits; 5/10/20-session load steps and p95/RSS targets from design report. Only claim tests/deployment actually performed. Dedicated live test accounts only; no user data access.
