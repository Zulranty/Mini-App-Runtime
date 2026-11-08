param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\..\Output\Windows"),
    [switch]$SelfContained,
    [switch]$NoRestore
)

$project = Join-Path $PSScriptRoot "MiniAppRuntime.Windows.csproj"
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$cache = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\Cache\Windows"))
$staging = Join-Path $cache "publish"
$runtime = Join-Path $output "Data"
$executable = Join-Path $output "MiniApps.exe"
$interface = Join-Path $output "Interface"
$miniApps = Join-Path $output "MiniApps"
$userData = Join-Path $runtime "User"
$userDataBackup = Join-Path $cache "data-user-backup"
$webViewUserData = Join-Path $runtime "WebView2\UserData"
$webViewUserDataBackup = Join-Path $cache "webview-user-data-backup"
$config = Join-Path $output "Config"
$configBackup = Join-Path $cache "config-backup"

New-Item -ItemType Directory -Path $cache -Force | Out-Null
# A previous interrupted publish may have moved user data into Cache.
# Restore it before touching the staging tree; never discard a saved copy.
foreach ($pair in @(
    @($userDataBackup, $userData),
    @($webViewUserDataBackup, $webViewUserData),
    @($configBackup, $config)
)) {
    $saved, $destination = $pair
    if (Test-Path -LiteralPath $saved) {
        if (Test-Path -LiteralPath $destination) { throw "Saved publish data and destination both exist: $saved" }
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Move-Item -LiteralPath $saved -Destination $destination
    }
}
if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
$publishArguments = @($project, "-c", "Release", "-r", "win-x64", "-o", $staging)
if ($SelfContained) { $publishArguments += "--self-contained" }
if ($NoRestore) { $publishArguments += "--no-restore" }
dotnet publish @publishArguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Path $output -Force | Out-Null
# A previous publish may have left runtime dependencies beside the EXE. Remove
# only items emitted by this publish; user-owned MiniApps and Interface remain.
Get-ChildItem -Force $staging | Where-Object { $_.Name -notin @("MiniApps.exe", "MiniApps", "Interface") } | ForEach-Object {
    $previous = Join-Path $output $_.Name
    if (Test-Path $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
}
if (Test-Path $userData) { Move-Item -LiteralPath $userData -Destination $userDataBackup }
if (Test-Path $webViewUserData) { Move-Item -LiteralPath $webViewUserData -Destination $webViewUserDataBackup }
if (Test-Path $config) { Move-Item -LiteralPath $config -Destination $configBackup }
if (Test-Path $runtime) { Remove-Item -LiteralPath $runtime -Recurse -Force }
if (Test-Path $executable) { Remove-Item -LiteralPath $executable -Force }

Move-Item -LiteralPath (Join-Path $staging "MiniApps.exe") -Destination $executable
New-Item -ItemType Directory -Path $runtime | Out-Null
Get-ChildItem -Force $staging | Where-Object { $_.Name -notin @("Interface", "MiniApps", "runtimes") } | Move-Item -Destination $runtime
New-Item -ItemType Directory -Path (Join-Path $runtime "WebView2") -Force | Out-Null
@("WebView2Loader.dll", "Microsoft.Web.WebView2.Core.xml", "Microsoft.Web.WebView2.WinForms.xml") | ForEach-Object {
    $source = Join-Path $runtime $_
    if (Test-Path $source) { Move-Item -LiteralPath $source -Destination (Join-Path $runtime "WebView2") -Force }
}
foreach ($folderName in @("Interface", "MiniApps")) {
    $packageRoot = Join-Path $staging $folderName
    if (-not (Test-Path -LiteralPath $packageRoot)) { continue }
    $installedRoot = Join-Path $output $folderName
    New-Item -ItemType Directory -Path $installedRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $packageRoot -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($packageRoot.TrimEnd('\').Length + 1)
        if ($folderName -ne "MiniApps" -or [System.IO.Path]::GetFileName($relative) -notin @("storage.json", "storage.json.bak")) {
            $destination = Join-Path $installedRoot $relative
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
        }
    }
}
Remove-Item -LiteralPath $staging -Recurse -Force
if (Test-Path $userDataBackup) { Move-Item -LiteralPath $userDataBackup -Destination $userData }
if (Test-Path $webViewUserDataBackup) { Move-Item -LiteralPath $webViewUserDataBackup -Destination $webViewUserData }
if (Test-Path $configBackup) { Move-Item -LiteralPath $configBackup -Destination $config }

# The portable package root intentionally contains only the executable and
# user-owned content. Every other publish artifact belongs in Data.
$rootItems = @("Interface", "MiniApps", "Data", "Config", "MiniApps.exe", "MiniAppsSetup.exe")
Get-ChildItem -Force $output | Where-Object { $_.Name -notin $rootItems } | Remove-Item -Recurse -Force
