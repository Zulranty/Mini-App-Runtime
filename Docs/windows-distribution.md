# Windows distribution

## Build

Run these commands from the project root:

```bat
build\Scripts\BuildWindows.cmd
build\Scripts\BuildAndroid.cmd
build\Scripts\BuildAll.cmd
```

`BuildWindows.cmd` creates `Output/Windows/MiniAppsSetup.exe`. `BuildAndroid.cmd` creates the release APK at `Output/Android/MiniApps.apk`. `BuildAll.cmd` runs both scripts; none of these scripts creates an Android debug APK.

Android uses the committed Gradle Wrapper in `build/Android`, which downloads Gradle 8.14 on its first run. Windows restores NuGet packages automatically when its cache is absent. The first build therefore needs internet access.

Before building, the scripts check their prerequisites: Android requires JDK 17+, Android SDK Platform 35, and the committed Wrapper; Windows requires .NET SDK 8+ and Inno Setup 6+.

The `build` directory stores the build configurations and scripts. Re-creatable intermediates are written to `Cache` and may be deleted; final distributables remain in `Output`.

## Installed layout

The Windows installer lets the user choose a writable folder. If its path does not already contain `MiniApps` as a folder name, the installer adds the final `MiniApps` folder.

```text
MiniApps/
|- MiniApps.exe
|- MiniApps/                 default mini-app packages and installed mini-apps
|- Interface/                launcher interfaces
|  `- default/
|     `- index.html
`- Data/                     runtime files and all private application state
   |- WebView2/              WebView2 loader and managed-library XML documentation
   |  `- UserData/           WebView2 profile
   `- User/                  private and secure mini-app storage
`- Config/                   launcher configuration
   |- window-sizes.json
   |- launcher-interface.txt
   `- Permissions/           permission files named after mini-apps
```

The uninstaller files `unins000.exe` and `unins000.dat` are stored in `Data`.

## Packaged content and offline updates

The installer is fully offline: it updates the selected installation using only files inside `MiniAppsSetup.exe`.

- `DefaultContent/MiniApps` and `DefaultContent/Interface` are copied into one self-contained Windows publish result as `MiniApps` and `Interface`; Inno Setup builds the installer from that same result without a second publish. Before Inno Setup runs, the build verifies that the executable, the default interface, and at least one mini-app manifest are present.
- An update refreshes built-in mini-app code and manifests while preserving `storage.json`; user-added mini-app folders and `.runtime` are kept. Each bundled interface subdirectory needs an `index.html`; `DefaultContent/Interface/default/index.html` is the bundled default. Packaged interface files are refreshed during an update, while additional custom interface folders are not removed.
- Runtime binaries and libraries are refreshed in `Data`; `Data/User` and `Data/WebView2/UserData` are preserved. `Config` is also preserved, including window size, selected interface, and mini-app permission settings. Imported ZIP and HTML packages are installed directly and are not retained as source copies.

## Dependencies

The installer does not bundle .NET or WebView2. It accepts any installed x64 .NET Desktop Runtime with major version 8 or higher and offers the official download page only if none is found. The app uses the system Microsoft Edge WebView2 Runtime.

## Versioning

`build/version.properties` is the single source of truth: `APP_VERSION` is used by Android and the Windows installer, while `ANDROID_VERSION_CODE` is used by Android.
