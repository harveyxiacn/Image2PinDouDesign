# 构建 Android 调试版 APK（拼豆仓）。需要：Android SDK、JDK 21（Android Studio 自带 jbr 即可）。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1 [-SdkDir 路径] [-JavaHome 路径] [-Release]
param(
  [string]$SdkDir = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { "$env:LOCALAPPDATA\Android\Sdk" }),
  [string]$JavaHome = $(if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "C:\Program Files\Android\Android Studio\jbr" }),
  [switch]$SkipWebBuild
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path $SdkDir)) { throw "找不到 Android SDK：$SdkDir（用 -SdkDir 指定）" }
if (-not (Test-Path "$JavaHome\bin\java.exe")) { throw "找不到 JDK：$JavaHome（用 -JavaHome 指定）" }
$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = $SdkDir
$env:Path = "$JavaHome\bin;$env:Path"

if (-not $SkipWebBuild) {
  & node node_modules/vite/bin/vite.js build --config web/vite.config.ts
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if (-not (Test-Path android)) {
  & node node_modules/@capacitor/cli/bin/capacitor add android
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& node node_modules/@capacitor/cli/bin/capacitor sync android
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node scripts/patch-android.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$sdkEscaped = $SdkDir.Replace("\", "\\").Replace(":", "\:")
Set-Content -Path android\local.properties -Value "sdk.dir=$sdkEscaped" -Encoding ascii
Push-Location android
try {
  & .\gradlew.bat assembleDebug --no-daemon
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }
$apk = Get-ChildItem android\app\build\outputs\apk\debug\*.apk | Select-Object -First 1
if (-not $apk) { throw "没有生成 APK" }
New-Item -ItemType Directory -Force release | Out-Null
Copy-Item $apk.FullName release\pindou-hub-debug.apk -Force
Write-Host "APK: $(Resolve-Path release\pindou-hub-debug.apk)"
