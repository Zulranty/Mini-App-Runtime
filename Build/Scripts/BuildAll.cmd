@echo off
setlocal
set "MINIAPPS_NO_PAUSE=1"
if not "%~1"=="" if /i not "%~1"=="Local" (
  echo Usage: BuildAll.cmd [Local]
  exit /b 2
)
call "%~dp0BuildWindows.cmd"
if errorlevel 1 goto Fail
call "%~dp0BuildAndroid.cmd" %1
if errorlevel 1 goto Fail
exit /b 0

:Fail
set "BUILD_EXIT_CODE=%errorlevel%"
if "%BUILD_EXIT_CODE%"=="0" set "BUILD_EXIT_CODE=1"
echo.
echo Full build failed with exit code %BUILD_EXIT_CODE%.
if not defined MINIAPPS_NONINTERACTIVE pause
exit /b %BUILD_EXIT_CODE%
