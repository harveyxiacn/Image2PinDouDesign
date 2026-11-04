# 构建 → 用临时数据目录启动一个只监听 127.0.0.1 的 Hub → 浏览器冒烟 → 停掉这个 Hub（只停自己启动的进程）。
param(
  [string]$Chart = "..\docs\samples\agumon-detail-20260907.png",
  [string]$Photo = "..\testimage\亚古兽.jpg",
  [string]$Out = "$env:TEMP\pindou-hub-smoke",
  [int]$Port = 18790,
  [switch]$SkipBuild
)
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not $SkipBuild) {
  cmd /c "node node_modules/typescript/bin/tsc -p web/tsconfig.json --noEmit > %TEMP%\pindou-hub-smoke-tsc.log 2>&1"
  if ($LASTEXITCODE -ne 0) { Get-Content "$env:TEMP\pindou-hub-smoke-tsc.log" -Tail 40; exit $LASTEXITCODE }
  cmd /c "node node_modules/vite/bin/vite.js build --config web/vite.config.ts > %TEMP%\pindou-hub-smoke-build.log 2>&1"
  if ($LASTEXITCODE -ne 0) { Get-Content "$env:TEMP\pindou-hub-smoke-build.log" -Tail 40; exit $LASTEXITCODE }
  "build ok"
}
$data = Join-Path $env:TEMP "pindou-hub-smoke-data"
Remove-Item -Recurse -Force $data -EA SilentlyContinue
$hub = Start-Process -FilePath (Get-Command node).Source -ArgumentList @("server/hub.mjs", "--port", "$Port", "--host", "127.0.0.1", "--data", "`"$data`"") -PassThru -NoNewWindow -RedirectStandardOutput "$env:TEMP\pindou-hub-smoke-hub.log" -RedirectStandardError "$env:TEMP\pindou-hub-smoke-hub.err"
try {
  $ok = $false
  for ($i = 0; $i -lt 50; $i++) { try { Invoke-RestMethod "http://127.0.0.1:$Port/api/ping" -TimeoutSec 2 | Out-Null; $ok = $true; break } catch { Start-Sleep -Milliseconds 200 } }
  if (-not $ok) { throw "hub did not start" }
  $chartFull = (Resolve-Path $Chart).Path; $photoFull = (Resolve-Path $Photo).Path
  cmd /c "node scripts/smoke.mjs http://127.0.0.1:$Port/ `"$Out`" `"$chartFull`" `"$photoFull`" > %TEMP%\pindou-hub-smoke-run.log 2>&1"
  $code = $LASTEXITCODE
  Get-Content "$env:TEMP\pindou-hub-smoke-run.log" -Encoding UTF8 -Tail 80
} finally {
  if ($hub -and -not $hub.HasExited) { Stop-Process -Id $hub.Id -Force }
}
exit $code
