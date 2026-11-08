@echo off
setlocal
cd /d "%~dp0..\.."

set "PREREQUISITE_ARGS="
set "SIGNING_ARGUMENT="
set "APK_NAME=MiniApps.apk"
if "%~1"=="" goto Build
if /i not "%~1"=="Local" (
  echo Usage: BuildAndroid.cmd [Local]
  exit /b 2
)
set "PREREQUISITE_ARGS=-LocalSigning"
set "SIGNING_ARGUMENT=-Pminiapps.localSigning=true"
set "APK_NAME=MiniApps-local.apk"
echo Local APK: signing automatically with the Android debug certificate.

:Build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\build\Scripts\Test-Prerequisites.ps1" -Target Android %PREREQUISITE_ARGS%
if errorlevel 1 goto Fail

set "GRADLE_BAT=%CD%\build\Android\gradlew.bat"
if not exist "%GRADLE_BAT%" (
  echo Gradle Wrapper is missing. Restore build\Android\gradlew.bat from the repository.
  goto Fail
)

echo Building Android Release APK...
call "%GRADLE_BAT%" -p "%CD%\build\Android" --project-cache-dir "%CD%\Cache\Gradle\project" -P "kotlin.project.persistent.dir=%CD%\Cache\Kotlin" %SIGNING_ARGUMENT% :android:app:assembleRelease
if errorlevel 1 goto Fail

set "OUTPUT_DIR=%CD%\Output\Android"
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"
copy /Y "%CD%\Cache\Android\app\outputs\apk\release\app-release.apk" "%OUTPUT_DIR%\%APK_NAME%" >nul
if errorlevel 1 goto Fail
echo Android APK: "%OUTPUT_DIR%\%APK_NAME%"
exit /b 0

:Fail
set "BUILD_EXIT_CODE=%errorlevel%"
if "%BUILD_EXIT_CODE%"=="0" set "BUILD_EXIT_CODE=1"
echo.
echo Android build failed with exit code %BUILD_EXIT_CODE%.
if not defined MINIAPPS_NO_PAUSE pause
exit /b %BUILD_EXIT_CODE%
