# Windows distribution

## Build

Run `Build\Scripts\BuildWindows.cmd` from the repository root to create
`Output\Windows\MiniAppsSetup.exe`. The build requires .NET SDK 10 or newer
and Inno Setup 6. The script restores NuGet dependencies before publishing.
The first build needs access to the package sources.

Use `Build\Scripts\BuildAll.cmd` to build both platforms. For Android APK
signing and bundle options, see [Requirements](README.md#requirements).
Build intermediates go to `Cache` and distributable artifacts go to `Output`.

For unattended builds, set `MINIAPPS_NO_PAUSE=1` for an individual platform
script or `MINIAPPS_NONINTERACTIVE=1` for `BuildAll.cmd`.

## Installed layout

The Windows installer lets the user choose a writable folder. If its path does not already contain `MiniApps` as a folder name, the installer adds the final `MiniApps` folder.

```text
MiniApps/
|- MiniApps.exe
|- MiniApps/                 installed mini-apps and shared modules
|- Interface/                launcher interfaces
|  `- default/
|     `- index.html
|- Data/                     runtime files and private application state
|  |- BundledMiniApps/       bundled app archives applied on startup
|  |- WebView2/              WebView2 loader and managed-library XML documentation
|  |  `- UserData/           WebView2 profile
|  `- User/                  private and secure mini-app storage
`- Config/                   launcher configuration
   |- window-sizes.json
   |- launcher-interface.txt
   `- Permissions/           permission files keyed by app ID hash
```

The uninstaller files `unins000.exe` and `unins000.dat` are stored in `Data`.

## Packaged content and offline updates

The installer updates the selected installation offline when .NET Desktop Runtime and WebView2 are already installed.

- The Windows executable is published once. Inno Setup stages the same packaged content used by the portable output. The build excludes mini-app test and tool folders, source snapshots, public storage and runtime state. The staging directory also excludes local configuration, WebView2 profile, private data and custom apps or interfaces. Before Inno Setup runs, the build verifies that the executable, the default interface, and at least one bundled application archive are present.
- Inno Setup writes into `Cache/Windows/installer-output`; `Output/Windows/MiniAppsSetup.exe` is replaced only after compilation succeeds. An interrupted publish restores saved configuration and WebView2 profile data on the next run.
- Setup ships bundled archives in `Data/BundledMiniApps`. At startup the host validates and applies them through the normal package installer. It preserves public storage, user-added apps, permission decisions for retained capabilities, and eligible previous versions. Setup also refreshes packaged interfaces while preserving additional custom interface folders.
- Runtime binaries and libraries are refreshed in `Data`; `Data/User` and `Data/WebView2/UserData` are preserved. `Config` is also preserved, including window size, selected interface, and mini-app permission settings. Imported ZIP and HTML packages are installed directly and are not retained as source copies.

## Dependencies

Windows setup requires the x64 .NET 10 Desktop Runtime and Microsoft Edge
WebView2 Runtime. It offers the relevant Microsoft download page when a
dependency is missing. For an offline machine, prepare the standalone
Microsoft installers separately.

## Versioning

`Build/version.properties` defines `APP_VERSION` for the Android package, the Windows executable, and the Windows installer. The launcher shows the version embedded in the running app. Android also uses `ANDROID_VERSION_CODE` for package updates.
