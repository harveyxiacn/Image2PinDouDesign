# Private warehouse release and recovery

This is a first-install path for `rabisu2` / `brightmaple-web` only. Do not run the legacy
`promote-release.sh` after the warehouse is installed. It now refuses cloud sites; a later upgrade
must preserve both applications, back up the live SQLite database consistently, and be reviewed separately.

## Release gates

1. Preserve the dirty working baseline outside the repository with checksums and a verified restore.
2. Run root regression/build, Hub regression/build, cloud/LAN server tests, real browser data and actual
   form tests, and independent authentication/isolation/concurrency/deployment review. Resolve blockers.
3. Build locally. Stage `workshop/` from root `dist/`, `warehouse/` from `pindou-hub/dist/`, `cloud/`
   with only `server.mjs` and `backup.mjs`, and the reviewed `deploy/` scripts/configs. Convert shell/config
   text to LF, generate SHA256 checksums and verify them after transfer. Never include `.env`, local
   configs, `.task-cloud`, live databases, screenshots with account secrets, or credentials.
4. Refresh hostname, disk, memory, listening ports and target configuration. Installation budgets allocated
   payload ×2 + old site ×2 +64MiB, in addition to the 1GiB reserve. New service has 180MiB hard memory,
   120MiB high memory and 50% CPU limits. Account payload limit is 4MiB, warning 2MiB, registration cap100;
   service data limit300MiB. These are limits, not demonstrated capacity promises.
5. Test Node22 compatibility and the resource-limited synthetic workload in an isolated temporary fixture,
   never against real accounts or existing data. Stop if disk reserve/shared services are affected.
6. Run `install-cloud.sh` against its unique `/opt/pindou-cloud/staging/<release>` payload. It refuses
   existing cloud DB/environment or conflicting release paths. Registration starts **disabled**.
7. Verify systemd restrictions, loopback binding, HTTPS/Secure cookie, no-cache API, effective trusted
   real-IP chain, `/api/` refusal, both static apps and all referenced assets. Never expose the LAN service.
8. Execute an off-host consistent backup and restore drill before opening registration. Then temporarily
   allow dedicated acceptance accounts and run `CLOUD_UI_BASE=https://pindou.fanni-panda.com/warehouse/`
   with `node deploy/test-cloud-ui.mjs`. Test accounts contain synthetic data only. Do not log their
   passwords/cookies/recovery codes. Verify two-account isolation and actual sync/receipt/UI behavior.
9. Record exact commits, artifact hashes, live results, resource measurements and remaining limitations.
   Enable ongoing registration only after the gates pass; never describe staged code as live.

## Backup and restore

`deploy/backup-cloud.ps1` creates a consistent SQLite VACUUM snapshot in a separate remote directory,
using a transient systemd unit with 20% CPU,180MiB memory, low IO priority,300s runtime limit and a
nonblocking flock. It transfers the snapshot to a private local directory, compares SHA256 and exercises
the backend restore/integrity checks before removing that individually named remote temporary snapshot.
The task backup directory is outside Git and must never be uploaded or committed.

Run daily via a local scheduled task and check `last-success.json`; the local machine must be powered on
and able to authenticate. RPO24h/RTO4h are objectives, not guarantees from one successful drill. Missing
or stale success evidence is an operator alert. Do not blindly retry a growing list of failed snapshots.
Inspect only the task's snapshot filenames/sizes, preserve diagnostic evidence, and remove a failed file
only after confirming a good off-host copy or determining that it is an incomplete disposable snapshot.

For disaster restoration, stop **only** `pindou-cloud`, preserve the existing database and WAL/SHM together,
restore the selected off-host snapshot to a new staging database with `backup.mjs restore`, verify integrity
and required data, then switch the service database under the correct private ownership. Never overwrite
a live SQLite file, never restore only the main DB while leaving unrelated WAL files, and never roll back
user data merely because application deployment failed. This recovery requires its own reviewed execution.

## Deployment rollback

The installer saves target nginx config, optional previous cloud config/service/environment, prior symlink,
service state and a static archive under `/var/backups/pindou-cloud/<release>`. An ERR trap invokes the
saved rollback script before any service/config/static mutation. The old static directory is retained as
`/var/www/image2pindou.before-<release>`; there is no recursive deletion of sites or user data.

`bash /var/backups/pindou-cloud/<release>/rollback-cloud.sh /var/backups/pindou-cloud/<release>` restores
the prior app/config/service state and archives the failed deployment. It retains the new cloud database.
The script is a deployment rollback, not a data restore. Isolated four-case filesystem tests mock systemctl
and nginx; a live restore/redeploy exercise is still needed to claim production rollback verification.

## Evidence scope

Local outputs belong in ignored `docs/samples/`; durable summaries belong in DEVLOG/iteration records.
`test-pwa-transition.mjs` uses a representative old catch-all worker and route markers. It proves the update
prompt transition locally; it does not prove that every installed old worker has already updated.
`test-cloud-ui.mjs` uses compiled assets and actual forms locally, and supports explicit live URL testing.
`cloud-browser-check.mjs` exercises data operations in real browsers; it is complementary to form testing.
