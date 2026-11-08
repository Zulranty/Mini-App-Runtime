@echo off
setlocal
cd /d "%~dp0..\.."
if /i "%~1"=="Android" goto Android
if /i "%~1"=="Windows" goto Windows
echo Usage: TestLocalDevices.cmd Windows ^| Android
exit /b 2
:Windows
rem First run BuildWindows.cmd: exercise its actual compiled production service.
dotnet run --project "Build\Tests\LocalDevices\LocalDevices.csproj" -- "Cache\Windows\bin\Release\net8.0-windows10.0.18362.0\win-x64\MiniApps.dll"
exit /b %errorlevel%
:Android
rem JVM tests compile the production Kotlin code but do not package or sign an APK.
call "Build\Android\gradlew.bat" -p "Build\Android" --project-cache-dir "Cache\Gradle\project" -P "kotlin.project.persistent.dir=%CD%\Cache\Kotlin" :android:app:testReleaseUnitTest
exit /b %errorlevel%
