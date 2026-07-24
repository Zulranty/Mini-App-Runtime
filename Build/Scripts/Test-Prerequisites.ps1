param(
    [ValidateSet("Android", "Windows")]
    [string]$Target
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
    Write-Error $Message
    exit 1
}

if ($Target -eq "Android") {
    $wrapper = Join-Path $PSScriptRoot "..\Android\gradlew.bat"
    if (-not (Test-Path -LiteralPath $wrapper)) {
        Fail "Gradle Wrapper is missing: $wrapper"
    }

    $javac = Get-Command javac.exe -ErrorAction SilentlyContinue
    if (-not $javac) { Fail "JDK 17 or newer is required. javac.exe was not found in PATH." }
    $javacVersion = (& $javac.Source -version 2>&1 | Out-String).Trim()
    $match = [regex]::Match($javacVersion, '(\d+)(?:\.|$)')
    if (-not $match.Success -or [int]$match.Groups[1].Value -lt 17) {
        Fail "JDK 17 or newer is required. Found: $javacVersion"
    }

    $androidSdk = @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME, (Join-Path $env:LOCALAPPDATA "Android\Sdk")) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_) } |
        Select-Object -First 1
    if (-not $androidSdk) { Fail "Android SDK was not found. Set ANDROID_SDK_ROOT or ANDROID_HOME." }
    if (-not (Test-Path -LiteralPath (Join-Path $androidSdk "platforms\android-35"))) {
        Fail "Android SDK Platform 35 is required: $androidSdk"
    }

    Write-Host "Android prerequisites OK: $javacVersion; SDK $androidSdk"
    exit 0
}

$dotnet = Get-Command dotnet.exe -ErrorAction SilentlyContinue
if (-not $dotnet) { Fail ".NET SDK 8 or newer is required. dotnet.exe was not found in PATH." }
$sdkVersions = (& $dotnet.Source --list-sdks 2>&1 | ForEach-Object {
    if ($_ -match '^(\d+)\.') { [int]$Matches[1] }
})
if (-not ($sdkVersions | Where-Object { $_ -ge 8 })) {
    Fail ".NET SDK 8 or newer is required."
}

$isccPath = (Get-Command iscc.exe -ErrorAction SilentlyContinue).Source
$innoSetup6 = $null
if ([string]::IsNullOrWhiteSpace($isccPath)) {
    $innoSetup6 = Get-ItemProperty -Path "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1" -ErrorAction SilentlyContinue
    $installLocation = $innoSetup6.InstallLocation
    $candidate = if ($installLocation) { Join-Path $installLocation "ISCC.exe" } else { $null }
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { $isccPath = $candidate }
}
if ([string]::IsNullOrWhiteSpace($isccPath)) { Fail "Inno Setup 6 is required. iscc.exe was not found." }
$isccVersion = if ($innoSetup6) { $innoSetup6.DisplayVersion } else { (Get-Item -LiteralPath $isccPath).VersionInfo.ProductVersion }
if (-not $innoSetup6) {
    $isccMatch = [regex]::Match($isccVersion, '(\d+)(?:\.|$)')
    if ($isccMatch.Success -and [int]$isccMatch.Groups[1].Value -lt 6) {
        Fail "Inno Setup 6 or newer is required. Found: $isccVersion"
    }
}

Write-Host "Windows prerequisites OK: .NET SDK $($sdkVersions -join ', '); Inno Setup $isccVersion"
