@echo off
setlocal
call "%~dp0BuildWindows.cmd"
if errorlevel 1 exit /b %errorlevel%
call "%~dp0BuildAndroid.cmd"
exit /b %errorlevel%
