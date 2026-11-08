# Windows launcher

The concise distribution reference is also available at [`docs/windows-distribution.md`](../docs/windows-distribution.md).

The Windows application is a small .NET/WinForms shell around the system Microsoft Edge WebView2 Runtime. It does not ship Chromium.

Build a compact framework-dependent executable:

```powershell
.\build\Windows\publish-windows.ps1
```

`build\Scripts\BuildWindows.cmd` restores the Windows SDK reference pack on every run before publishing. This avoids stale cached NuGet assets that can otherwise cause `NETSDK1112` when a required reference pack has not been downloaded yet.

The shared web bridge `runtime.js` is copied on every Windows publish, so new `mini.*` APIs cannot be hidden by a stale publish-cache copy.

Publishing into an existing `Output/Windows` refreshes packaged mini-app and
interface files in place. User-added app and interface folders, public
`storage.json`, private data, WebView2 profile data, and configuration are
preserved. The publish script does not replace either content directory as a
whole.

The distributable keeps `MiniApps.exe`, `MiniApps`, `Interface`, and `Config` directly in `Output/Windows`. `Data/WebView2` contains the WebView2 loader and its XML documentation files; the WebView2 profile is stored in `Data/WebView2/UserData`. Window sizes, the selected launcher interface, and mini-app permissions are stored in `Config`; permission files use mini-app names. Private and secure mini-app storage remains in `Data/User`, while public storage remains inside the mini-app directory as `storage.json`.

## Offline Windows installer

Create `Output/Windows/MiniAppsSetup.exe` with:

```powershell
.\build\Windows\publish-installer.ps1
```

The setup defaults to `%LOCALAPPDATA%\MiniApps` and lets the user choose another writable program folder. If the chosen folder does not already end in `MiniApps`, the installer appends that final folder name. Mini-apps, launcher interfaces, settings, private and secure storage, and WebView2 profile data all remain in that folder. Running a newer setup replaces program files while preserving those user-owned folders. The installer writes `unins000.exe` and `unins000.dat` into `Data`. It accepts .NET Desktop Runtime 8 or newer, checking system and user locations, `DOTNET_ROOT`, the registry, and `dotnet --list-runtimes`; it opens the official download page only when none of those checks finds a compatible runtime. The application uses the standard installed Microsoft Edge WebView2 Runtime; Windows 11 includes it, while a small number of Windows 10 devices can require a separate WebView2 Runtime installation. Building the setup requires Inno Setup 6 (`iscc.exe`).

When an update includes a built-in mini-app, its code files and manifest are refreshed. The installer preserves that app's `storage.json`, `.runtime`, and mini-app folders that are not part of the shipped package. Imported ZIP and HTML packages are installed directly and are not retained as source copies.

The launcher UI is loaded from `Interface/<name>/index.html`. Interfaces packaged with the application come from `DefaultContent/Interface`, where each interface is a separate subfolder (for example, `DefaultContent/Interface/default`). Custom HTML, ZIP, and folder interfaces can be selected in the launcher settings.

The native launcher exposes `launcher.list()`, `launcher.getAppInfo(id)`, `launcher.open(id)`, `launcher.openNewWindow(id)`, `launcher.refresh()`, `launcher.importApp()`, `launcher.deleteApp(id)`, `launcher.shareApp(id)`, `launcher.shareAppData(id)`, `launcher.getSettingsInfo()`, `launcher.listInterfaces()`, `launcher.selectInterface(id)`, `launcher.importInterface()`, `launcher.getInterfaceSettings()`, and `launcher.setInterfaceSettings(settings)` to this interface. `shareApp(id)` creates a standalone HTML when the installed app is already a self-contained HTML with an embedded manifest; otherwise it creates a ZIP of its code. It excludes all user data, including `storage.json`. `shareAppData(id)` exports only that app's public `storage.json`; private and secure storage remain excluded. `getInterfaceSettings()` reads the active interface's `Interface/<id>/settings.json` and returns `{}` for a missing or malformed file. `setInterfaceSettings()` accepts a JSON object only, limits its UTF-8 serialization to 64 KiB, and atomically replaces that file; the host derives the active interface path itself. `launcher.getAppInfo(id)` returns the app manifest, installation and update timestamps, and application/data size breakdown. Windows share actions copy their text/file payload to the clipboard.

Trusted launcher interfaces can also call `launcher.getRollbackInfo(id)`, `launcher.rollbackApp(id)`, and `launcher.deleteRollback(id)`. An update retains one previous app directory and source under `MiniApps/.runtime/rollback/<appId>`. Rollback swaps source versions but deliberately does not roll back public, private, or secure data. `launcher.getAppPermissions(id)`, `launcher.setAppPermission(id, permission, state)`, and `launcher.resetAppPermissions(id)` manage manifest-declared permission decisions. These management methods are never available to mini-app JavaScript.

Backup APIs are reserved in the shared launcher contract, but native backup/restore file dialogs and restore execution are not implemented yet. Feature-detect `backup.restore` before presenting it in an interface.

## Stage 2 system APIs

Windows supports controlled `mini.network.request`, network status events, multiple-file and directory handles, clipboard read, native dialogs/toast, and validated external URL/file/settings opening. Network requests are allowlist-controlled and cookie-free. Directory paths are never returned to JavaScript; persisted directory paths remain in local runtime data.

Windows haptics and persistent notification scheduling/activation are unavailable and are reported as such by `mini.runtime.getCapabilities()`.

## Windows window controls

- Click an app card to open it in the main window.
- Right-click an app card for the launcher context menu, including **Open** and **Open in new window**.
- Middle-click an app card to open it in a new window.
- The main-window app view has a **← Back** button that returns to the launcher.
- If at least one additional app window is open, closing the main window hides it in the notification area instead of exiting. Double-click the tray icon, or select **Open**, to restore it. Select **Exit** in the tray menu to exit explicitly.

## Native top bar API

## Windows taskbar title

Use `await mini.app.setWindowTitle('My mini-app')` to set the title of the active mini-app window. Windows displays this title in the taskbar, Alt+Tab, and the window caption. The launcher restores its own title when the mini-app is closed.

Each mini-app receives a native top bar. An interface-specific configuration can be placed in `Interface/<name>/appbar.js`; it calls `mini.ui.setTopBar(config)` after the page loads. The Windows host draws the bar and reserves its height above the WebView, so page content never overlaps it.

`config` supports `visible`, `height` (40–120 px), `paddingX`, `paddingY`, `titleFontSize`, `title`, `background`, `foreground`, `accent`, `showBack`, `backText`, `backButton`, and up to four `actions`. Colors use `#RRGGBB`. An action has `id`, `label`, and optional `accent`; handle its click in the mini-app with `mini.events.on('ui.topBarAction', handler)`.

The `backButton` object keeps the complete appearance of the back button in the interface layer: `radius` (0–48 px), `paddingX` (4–48 px), `background`, `hoverBackground`, `foreground`, `border`, `borderOpacity` (0–255), and `fontSize` (7–20). The Windows host renders these settings with its own lightweight control, rather than a system `Button`, so rounded corners do not leave a rectangular or black background.
