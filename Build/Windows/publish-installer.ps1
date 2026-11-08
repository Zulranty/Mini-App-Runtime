param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\..\Output\Windows"),
    [switch]$NoRestore
)

$ErrorActionPreference = "Stop"
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$cacheRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\Cache\Windows"))
$application = Join-Path $cacheRoot "installer-source"
$application = [System.IO.Path]::GetFullPath($application)
$installerOutput = [System.IO.Path]::GetFullPath((Join-Path $cacheRoot "installer-output"))
if (-not $application.StartsWith($cacheRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
    -not $installerOutput.StartsWith($cacheRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Installer staging must stay within Cache/Windows."
}
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
    & (Join-Path $PSScriptRoot "publish-windows.ps1") -OutputDirectory $output -NoRestore:$NoRestore
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if (Test-Path -LiteralPath $application) { Remove-Item -LiteralPath $application -Recurse -Force }
    New-Item -ItemType Directory -Path $application -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $output "MiniApps.exe") -Destination $application
    $runtimeSource = Join-Path $output "Data"
    Get-ChildItem -LiteralPath $runtimeSource -Recurse -File -Force | ForEach-Object {
        $relative = $_.FullName.Substring($runtimeSource.TrimEnd('\').Length + 1)
        if ($relative -notmatch '^(User\\|WebView2\\UserData\\)' -and $_.Extension -ne '.pdb') {
            $destination = Join-Path (Join-Path $application "Data") $relative
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $destination
        }
    }
    $contentRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\DefaultContent"))
    foreach ($folderName in @("MiniApps", "Interface")) {
        $sourceRoot = Join-Path $contentRoot $folderName
        Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | ForEach-Object {
            $relative = $_.FullName.Substring($sourceRoot.TrimEnd('\').Length + 1)
            if ($folderName -ne "MiniApps" -or $_.Name -notin @("storage.json", "storage.json.bak")) {
                $destination = Join-Path (Join-Path $application $folderName) $relative
                New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
                Copy-Item -LiteralPath $_.FullName -Destination $destination
            }
        }
    }

    $requiredFiles = @("MiniApps.exe", "Interface\default\index.html")
    $missingFiles = $requiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $application $_)) }
    if ($missingFiles) { throw "Windows publish is missing required files: $($missingFiles -join ', ')" }
    if (-not (Get-ChildItem -LiteralPath (Join-Path $application "MiniApps") -Recurse -File -Filter "manifest.json" | Select-Object -First 1)) {
        throw "Windows publish is missing a bundled mini-app manifest."
    }

    $env:MINIAPP_SETUP_SOURCE = $application
    if (Test-Path -LiteralPath $installerOutput) { Remove-Item -LiteralPath $installerOutput -Recurse -Force }
    New-Item -ItemType Directory -Path $installerOutput -Force | Out-Null
    $env:MINIAPP_SETUP_OUTPUT = $installerOutput
    $env:MINIAPP_PRODUCT_VERSION = $version.Trim()
    & $isccPath $setupScript
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $builtSetup = Join-Path $installerOutput "MiniAppsSetup.exe"
    if (-not (Test-Path -LiteralPath $builtSetup)) { throw "Inno Setup did not create MiniAppsSetup.exe." }
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    Copy-Item -LiteralPath $builtSetup -Destination ($setup + ".new") -Force
    Move-Item -LiteralPath ($setup + ".new") -Destination $setup -Force
    if (Test-Path -LiteralPath $legacySetup) { Remove-Item -LiteralPath $legacySetup -Force }
}
finally {
    Remove-Item Env:MINIAPP_SETUP_SOURCE -ErrorAction SilentlyContinue
    Remove-Item Env:MINIAPP_SETUP_OUTPUT -ErrorAction SilentlyContinue
    Remove-Item Env:MINIAPP_PRODUCT_VERSION -ErrorAction SilentlyContinue
}
