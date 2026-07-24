@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "MERGE_SELF=%~f0"
set "MERGE_DIR=%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$text=[IO.File]::ReadAllText($env:MERGE_SELF,[Text.UTF8Encoding]::new($false));" ^
  "$marker='# POWERSHELL_START';" ^
  "$index=$text.LastIndexOf($marker,[StringComparison]::Ordinal);" ^
  "if($index -lt 0){throw 'Embedded PowerShell section was not found.'};" ^
  "$script=$text.Substring($index+$marker.Length);" ^
  "& ([ScriptBlock]::Create($script))"

set "MERGE_EXIT=%ERRORLEVEL%"

if "%MERGE_EXIT%"=="0" exit /b 0

echo.
echo Press any key to close this window...
pause >nul
exit /b %MERGE_EXIT%

# POWERSHELL_START

$ErrorActionPreference = 'Stop'

$temporaryPath = $null
$backupPath = $null

try {
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
}
catch {
}

function Read-TextFile {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $bytes = [System.IO.File]::ReadAllBytes($Path)

    if ($bytes.Length -eq 0) {
        return ''
    }

    # UTF-32 LE BOM
    if (
        $bytes.Length -ge 4 -and
        $bytes[0] -eq 0xFF -and
        $bytes[1] -eq 0xFE -and
        $bytes[2] -eq 0x00 -and
        $bytes[3] -eq 0x00
    ) {
        return [System.Text.Encoding]::UTF32.GetString(
            $bytes,
            4,
            $bytes.Length - 4
        )
    }

    # UTF-32 BE BOM
    if (
        $bytes.Length -ge 4 -and
        $bytes[0] -eq 0x00 -and
        $bytes[1] -eq 0x00 -and
        $bytes[2] -eq 0xFE -and
        $bytes[3] -eq 0xFF
    ) {
        $encoding = [System.Text.UTF32Encoding]::new($true, $true)

        return $encoding.GetString(
            $bytes,
            4,
            $bytes.Length - 4
        )
    }

    # UTF-8 BOM
    if (
        $bytes.Length -ge 3 -and
        $bytes[0] -eq 0xEF -and
        $bytes[1] -eq 0xBB -and
        $bytes[2] -eq 0xBF
    ) {
        return [System.Text.Encoding]::UTF8.GetString(
            $bytes,
            3,
            $bytes.Length - 3
        )
    }

    # UTF-16 LE BOM
    if (
        $bytes.Length -ge 2 -and
        $bytes[0] -eq 0xFF -and
        $bytes[1] -eq 0xFE
    ) {
        return [System.Text.Encoding]::Unicode.GetString(
            $bytes,
            2,
            $bytes.Length - 2
        )
    }

    # UTF-16 BE BOM
    if (
        $bytes.Length -ge 2 -and
        $bytes[0] -eq 0xFE -and
        $bytes[1] -eq 0xFF
    ) {
        return [System.Text.Encoding]::BigEndianUnicode.GetString(
            $bytes,
            2,
            $bytes.Length - 2
        )
    }

    # UTF-16 without BOM heuristic.
    if ($bytes.Length -ge 4) {
        $sampleLength = [Math]::Min($bytes.Length, 2000)
        $evenZeros = 0
        $oddZeros = 0

        for ($i = 0; $i -lt $sampleLength; $i++) {
            if ($bytes[$i] -eq 0) {
                if (($i % 2) -eq 0) {
                    $evenZeros++
                }
                else {
                    $oddZeros++
                }
            }
        }

        if ($oddZeros -gt ($sampleLength / 8)) {
            return [System.Text.Encoding]::Unicode.GetString($bytes)
        }

        if ($evenZeros -gt ($sampleLength / 8)) {
            return [System.Text.Encoding]::BigEndianUnicode.GetString($bytes)
        }
    }

    # Strict UTF-8 without BOM.
    try {
        $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
        return $strictUtf8.GetString($bytes)
    }
    catch {
        # Fallback for old Russian TXT files.
        $windows1251 = [System.Text.Encoding]::GetEncoding(1251)
        return $windows1251.GetString($bytes)
    }
}

try {
    if ([string]::IsNullOrWhiteSpace($env:MERGE_DIR)) {
        throw 'Не удалось определить папку, в которой находится файл.'
    }

    $directory = [System.IO.Path]::GetFullPath(
        $env:MERGE_DIR
    ).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )

    if (-not [System.IO.Directory]::Exists($directory)) {
        throw ('Папка не существует: {0}' -f $directory)
    }

    $outputPath = Join-Path $directory 'Documentation.txt'
    $outputFullPath = [System.IO.Path]::GetFullPath($outputPath)

    $files = @(
        Get-ChildItem -LiteralPath $directory -File |
        Where-Object {
            (
                $_.Extension -ieq '.txt' -or
                $_.Extension -ieq '.md'
            ) -and
            (
                [System.IO.Path]::GetFullPath($_.FullName) -ine
                $outputFullPath
            )
        } |
        Sort-Object Name
    )

    if ($files.Count -eq 0) {
        throw 'В этой папке нет файлов TXT или MD.'
    }

    $temporaryPath = Join-Path $directory (
        '.docs-{0}.tmp' -f [Guid]::NewGuid().ToString('N')
    )
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $writer = [System.IO.StreamWriter]::new(
        $temporaryPath,
        $false,
        $utf8
    )

    try {
        for ($i = 0; $i -lt $files.Count; $i++) {
            $file = $files[$i]

            try {
                $text = Read-TextFile -Path $file.FullName
            }
            catch {
                throw (
                    'Ошибка чтения файла "{0}": {1}' -f
                    $file.Name,
                    $_.Exception.Message
                )
            }

            if ($i -gt 0) {
                $writer.WriteLine()
                $writer.WriteLine()
            }

            $writer.Write($text)
        }
    }
    finally {
        $writer.Dispose()
    }

    if ([System.IO.File]::Exists($outputPath)) {
        $backupPath = $temporaryPath + '.backup'
        [System.IO.File]::Replace($temporaryPath, $outputPath, $backupPath)
        [System.IO.File]::Delete($backupPath)
        $backupPath = $null
    }
    else {
        [System.IO.File]::Move($temporaryPath, $outputPath)
    }

    exit 0
}
catch {
    if (
        -not [string]::IsNullOrWhiteSpace($temporaryPath) -and
        [System.IO.File]::Exists($temporaryPath)
    ) {
        [System.IO.File]::Delete($temporaryPath)
    }

    if (
        -not [string]::IsNullOrWhiteSpace($backupPath) -and
        [System.IO.File]::Exists($backupPath)
    ) {
        [System.IO.File]::Delete($backupPath)
    }

    Write-Host ''
    Write-Host 'ОШИБКА ОБЪЕДИНЕНИЯ ФАЙЛОВ' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Yellow
    Write-Host ''
    Write-Host ('Папка: {0}' -f $env:MERGE_DIR)
    Write-Host ''

    exit 1
}
