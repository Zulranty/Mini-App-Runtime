@echo off
setlocal
cd /d "%~dp0..\.."

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\build\Scripts\Test-Prerequisites.ps1" -Target Windows
if errorlevel 1 exit /b %errorlevel%

set "OUTPUT_DIR=%CD%\Output\Windows"
set "PROJECT_FILE=%CD%\build\Windows\MiniAppRuntime.Windows.csproj"
set "ASSETS_FILE=%CD%\Cache\Windows\obj\project.assets.json"
if exist "%ASSETS_FILE%" goto BuildWindows

echo Restoring Windows packages...
dotnet restore "%PROJECT_FILE%" --runtime win-x64
if errorlevel 1 exit /b %errorlevel%

:BuildWindows
echo Building Windows installer...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\build\Windows\publish-installer.ps1" -OutputDirectory "%OUTPUT_DIR%" -NoRestore
if errorlevel 1 exit /b %errorlevel%
echo Windows installer: "%OUTPUT_DIR%\MiniAppsSetup.exe"
