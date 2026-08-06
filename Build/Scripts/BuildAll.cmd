@echo off
setlocal
set "MINIAPPS_NO_PAUSE=1"
call "%~dp0BuildWindows.cmd"
if errorlevel 1 goto Fail
call "%~dp0BuildAndroid.cmd"
if errorlevel 1 goto Fail
exit /b 0

:Fail
set "BUILD_EXIT_CODE=%errorlevel%"
if "%BUILD_EXIT_CODE%"=="0" set "BUILD_EXIT_CODE=1"
echo.
echo Full build failed with exit code %BUILD_EXIT_CODE%.
pause
exit /b %BUILD_EXIT_CODE%
