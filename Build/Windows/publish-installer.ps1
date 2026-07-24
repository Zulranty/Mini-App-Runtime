param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\..\Output\Windows"),
    [switch]$NoRestore
)

$ErrorActionPreference = "Stop"
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$application = $output
$legacySetup = Join-Path $output "MiniAppRuntimeSetup.exe"
$setup = Join-Path $output "MiniAppsSetup.exe"
$setupScript = Join-Path $PSScriptRoot "Installer\MiniAppRuntime.iss"
$versionFile = Join-Path $PSScriptRoot "..\version.properties"
$isccPath = (Get-Command iscc.exe -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($isccPath)) {
    $uninstallKey = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1"
    $installLocation = (Get-ItemProperty -Path $uninstallKey -ErrorAction SilentlyContinue).InstallLocation
    $candidate = if ($installLocation) { Join-Path $installLocation "ISCC.exe" } else { $null }
    if ($candidate -and (Test-Path $candidate)) { $isccPath = $candidate }
}
if ([string]::IsNullOrWhiteSpace($isccPath)) {
    throw "Inno Setup 6 не найден. Установите его с https://jrsoftware.org/isdl.php, затем повторите команду."
}

$version = (Get-Content -LiteralPath $versionFile | Where-Object { $_ -match '^APP_VERSION=' } | Select-Object -First 1) -replace '^APP_VERSION=', ''
if ([string]::IsNullOrWhiteSpace($version)) { throw "APP_VERSION is missing from $versionFile" }

try {
    if (Test-Path $legacySetup) { Remove-Item -LiteralPath $legacySetup -Force }
    if (Test-Path $setup) { Remove-Item -LiteralPath $setup -Force }
    & (Join-Path $PSScriptRoot "publish-windows.ps1") -OutputDirectory $application -NoRestore:$NoRestore
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $requiredFiles = @("MiniApps.exe", "Interface\default\index.html")
    $missingFiles = $requiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $application $_)) }
    if ($missingFiles) { throw "Windows publish is missing required files: $($missingFiles -join ', ')" }
    if (-not (Get-ChildItem -LiteralPath (Join-Path $application "MiniApps") -Recurse -File -Filter "manifest.json" | Select-Object -First 1)) {
        throw "Windows publish is missing a bundled mini-app manifest."
    }

    $env:MINIAPP_SETUP_SOURCE = $application
    $env:MINIAPP_SETUP_OUTPUT = $output
    $env:MINIAPP_PRODUCT_VERSION = $version.Trim()
    & $isccPath $setupScript
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Remove-Item Env:MINIAPP_SETUP_SOURCE -ErrorAction SilentlyContinue
    Remove-Item Env:MINIAPP_SETUP_OUTPUT -ErrorAction SilentlyContinue
    Remove-Item Env:MINIAPP_PRODUCT_VERSION -ErrorAction SilentlyContinue
}
