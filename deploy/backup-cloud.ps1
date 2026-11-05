param(
  [string]$Destination = 'E:\Project\Image2PinDouDesign-task-backups\cloud-offsite',
  [string]$SshHost = 'rabisu2'
)
$ErrorActionPreference = 'Stop'
if ($SshHost -ne 'rabisu2') { throw 'This task is scoped to the authorized 102 host alias.' }
$backupDir = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $backupDir /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot secure local backup directory' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$name = "cloud-$stamp.sqlite"
$remote = "/var/backups/pindou-cloud/snapshots/$name"
$local = Join-Path $backupDir $name
$restored = Join-Path $backupDir "restore-check-$stamp.sqlite"
$sshArgs = @('-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ProxyJump=none',$SshHost)
$create = "umask 077; mkdir -p /var/backups/pindou-cloud/snapshots; chmod 700 /var/backups/pindou-cloud/snapshots; systemd-run --quiet --wait --pipe --collect --unit=pindou-cloud-backup-$stamp -p CPUQuota=20% -p MemoryMax=180M -p TasksMax=16 -p Nice=10 -p IOWeight=10 -p RuntimeMaxSec=300 -p TimeoutStopSec=10 -p UMask=0077 /usr/bin/flock -n /run/pindou-cloud-backup.lock /usr/bin/node /opt/pindou-cloud/current/backup.mjs backup /var/lib/pindou-cloud/cloud.sqlite $remote"
& ssh @sshArgs $create | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Remote consistent snapshot failed; remote file retained for diagnosis' }
& scp -q -o BatchMode=yes -o ConnectTimeout=15 -o ProxyJump=none "${SshHost}:$remote" $local
if ($LASTEXITCODE -ne 0) { throw 'Off-host transfer failed; remote snapshot retained' }
$remoteHash = ((& ssh @sshArgs "sha256sum $remote") -split '\s+')[0]
if ($LASTEXITCODE -ne 0 -or $remoteHash -notmatch '^[0-9a-fA-F]{64}$') { throw 'Cannot obtain snapshot checksum' }
$localHash = (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash
if ($localHash -ne $remoteHash) { throw 'Off-host snapshot checksum mismatch; remote snapshot retained' }
$restoreTool = Join-Path $PSScriptRoot '..\pindou-hub\server\cloud\backup.mjs'
& node $restoreTool restore $local $restored | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Local restore integrity check failed; all snapshots retained' }
# Delete only this task's individually named verified remote temporary snapshot.
if ($remote -notmatch '^/var/backups/pindou-cloud/snapshots/cloud-[0-9]{8}-[0-9]{6}\.sqlite$') { throw 'Unsafe remote cleanup path' }
& ssh @sshArgs "rm -- $remote"
if ($LASTEXITCODE -ne 0) { throw 'Verified off-host backup exists, but remote temporary cleanup failed' }
# Keep the original snapshot. The checked restore is redundant; resolve before deleting this one file.
if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($restored)) -ne $backupDir) { throw 'Unsafe restore cleanup path' }
Remove-Item -LiteralPath $restored
[pscustomobject]@{ completedAt=(Get-Date).ToUniversalTime().ToString('o'); file=$name; sha256=$localHash; bytes=(Get-Item -LiteralPath $local).Length; restoreIntegrity='ok' } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupDir 'last-success.json')
Write-Output "Verified off-host backup and restore: $name"
