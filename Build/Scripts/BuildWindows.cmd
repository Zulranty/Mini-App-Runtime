@echo off
setlocal
cd /d "%~dp0..\.."

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\build\Scripts\Test-Prerequisites.ps1" -Target Windows
if errorlevel 1 goto Fail

set "OUTPUT_DIR=%CD%\Output\Windows"
set "PROJECT_FILE=%CD%\build\Windows\MiniAppRuntime.Windows.csproj"
echo Restoring Windows packages...
rem Restore on every build: the cached assets file can reference a Windows SDK
rem reference pack that was never downloaded (NETSDK1112).
rem Allow a cached, complete package set to build when NuGet is temporarily offline.
dotnet restore "%PROJECT_FILE%" --runtime win-x64 --ignore-failed-sources
if errorlevel 1 goto Fail

:BuildWindows
echo Building Windows installer...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\build\Windows\publish-installer.ps1" -OutputDirectory "%OUTPUT_DIR%" -NoRestore
if errorlevel 1 goto Fail
echo Windows installer: "%OUTPUT_DIR%\MiniAppsSetup.exe"
exit /b 0

:Fail
set "BUILD_EXIT_CODE=%errorlevel%"
if "%BUILD_EXIT_CODE%"=="0" set "BUILD_EXIT_CODE=1"
echo.
echo Windows build failed with exit code %BUILD_EXIT_CODE%.
if not defined MINIAPPS_NO_PAUSE pause
exit /b %BUILD_EXIT_CODE%
