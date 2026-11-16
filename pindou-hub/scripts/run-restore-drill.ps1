# Sync restore drill (ASCII only so Windows PowerShell 5.1 parses it without a BOM).
# Build (optional) -> hub on 127.0.0.1:18795 with a TEMP data dir -> real Edge (CDP 9351..9353) -> wipe / restore / interrupt / skew / corrupt blob.
# Only stops the processes the drill itself started. Never touches pindou-hub/data.
param(
  [string]$Out = "$env:TEMP\pindou-restore-drill",
  [string]$Only = "",
  [switch]$SkipBuild
)
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not $SkipBuild) {
  cmd /c "node node_modules/vite/bin/vite.js build --config web/vite.config.ts > %TEMP%\pindou-restore-drill-build.log 2>&1"
  if ($LASTEXITCODE -ne 0) { Get-Content "$env:TEMP\pindou-restore-drill-build.log" -Tail 40; exit $LASTEXITCODE }
  "build ok"
}
$arguments = @("scripts/restore-drill.mjs", $Out)
if ($Only) { $arguments += @("--only", $Only) }
$started = Get-Date
& (Get-Command node).Source @arguments 2>&1 | ForEach-Object { "$_" }
$code = $LASTEXITCODE
"drill finished in $([int]((Get-Date) - $started).TotalSeconds)s, exit $code"
exit $code
