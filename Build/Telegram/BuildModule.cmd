@echo off
setlocal
cd /d "%~dp0..\.."
set "TELEGRAM_CACHE=%CD%\Cache\Telegram\module"
if not exist "%TELEGRAM_CACHE%" mkdir "%TELEGRAM_CACHE%"
for %%f in (package.json package-lock.json build-module.cjs range-upload.cjs telegram.js scheduling.js) do (
  copy /Y "%~dp0%%f" "%TELEGRAM_CACHE%\%%f" >nul
  if errorlevel 1 exit /b 1
)
call npm.cmd ci --prefix "%TELEGRAM_CACHE%" --ignore-scripts --no-fund
if errorlevel 1 exit /b %errorlevel%
node "%TELEGRAM_CACHE%\build-module.cjs" "%CD%\DefaultContent\MiniApps\Modules\telegram"
exit /b %errorlevel%
