param(
    [ValidateSet("Android", "Windows")]
    [string]$Target,
    [switch]$LocalSigning
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
    if (-not (Test-Path -LiteralPath (Join-Path $androidSdk "platforms\android-36"))) {
        Fail "Android SDK Platform 36 is required: $androidSdk"
    }

    if (-not $LocalSigning) {
        foreach ($name in @("MINIAPPS_ANDROID_KEYSTORE", "MINIAPPS_ANDROID_STORE_PASSWORD", "MINIAPPS_ANDROID_KEY_ALIAS", "MINIAPPS_ANDROID_KEY_PASSWORD")) {
            if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
                Fail "Android release signing requires $name. The debug key must not be used for distribution."
            }
        }
        if (-not (Test-Path -LiteralPath $env:MINIAPPS_ANDROID_KEYSTORE -PathType Leaf)) {
            Fail "Android release signing keystore was not found at MINIAPPS_ANDROID_KEYSTORE."
        }
    }

    Write-Host "Android prerequisites OK: $javacVersion; SDK $androidSdk"
    exit 0
}

$dotnet = Get-Command dotnet.exe -ErrorAction SilentlyContinue
if (-not $dotnet) { Fail ".NET SDK 10 or newer is required. dotnet.exe was not found in PATH." }
$sdkVersions = (& $dotnet.Source --list-sdks 2>&1 | ForEach-Object {
    if ($_ -match '^(\d+)\.') { [int]$Matches[1] }
})
if (-not ($sdkVersions | Where-Object { $_ -ge 10 })) {
    Fail ".NET SDK 10 or newer is required."
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
    if (-not $isccMatch.Success -or [int]$isccMatch.Groups[1].Value -eq 0) {
        # Some portable releases expose 0.0.0.0 in the executable metadata.
        # ISCC prints its major version before checking that the script exists.
        $missingScript = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString("N") + ".iss")
        $banner = (& {
            $ErrorActionPreference = "Continue"
            & $isccPath $missingScript 2>$null
        }) -join [Environment]::NewLine
        $isccMatch = [regex]::Match($banner, '(?m)^Inno Setup (\d+) Command-Line Compiler\r?$')
        if (-not $isccMatch.Success) { Fail "Could not determine the Inno Setup compiler version." }
        $isccVersion = $isccMatch.Groups[1].Value
    }
    if ([int]($isccVersion -split "\.")[0] -lt 6) {
        Fail "Inno Setup 6 or newer is required. Found: $isccVersion"
    }
}

Write-Host "Windows prerequisites OK: .NET SDK $($sdkVersions -join ', '); Inno Setup $isccVersion"
