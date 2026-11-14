# Windows launcher

See [Windows distribution](windows-distribution.md) for the installer layout and prerequisites.

The Windows application is a small .NET/WinForms shell around the system Microsoft Edge WebView2 Runtime. It does not ship Chromium.

Run Build/Scripts/BuildWindows.cmd from the repository root. It restores the
Windows SDK reference pack, publishes the framework-dependent portable
layout, and builds Output/Windows/MiniAppsSetup.exe with Inno Setup 6.

Setup checks for x64 .NET 10 Desktop Runtime and Microsoft Edge WebView2
Runtime. An offline installation works on a machine that already has both.
The default directory is %LOCALAPPDATA%/MiniApps.

Publishing preserves installed applications, custom interfaces, Config,
Data/User and Data/WebView2/UserData. Bundled applications are shipped as
archives under Data/BundledMiniApps and are applied by the host at startup.
Permission files are stored under Config/Permissions/by-id.

The launcher UI is loaded from `Interface/<name>/index.html`. Interfaces packaged with the application come from `DefaultContent/Interface`, where each interface is a separate subfolder (for example, `DefaultContent/Interface/default`). Custom HTML, ZIP, and folder interfaces can be selected in the launcher settings.

The native launcher exposes `launcher.list()`, `launcher.getAppInfo(id)`, `launcher.open(id)`, `launcher.openNewWindow(id)`, `launcher.refresh()`, `launcher.importApp()`, `launcher.deleteApp(id)`, `launcher.shareApp(id)`, `launcher.shareAppData(id)`, `launcher.getSettingsInfo()`, `launcher.listInterfaces()`, `launcher.selectInterface(id)`, `launcher.importInterface()`, `launcher.getInterfaceSettings()`, and `launcher.setInterfaceSettings(settings)` to this interface. `shareApp(id)` creates a standalone HTML when the installed app is already a self-contained HTML with an embedded manifest; otherwise it creates a ZIP of its code. It excludes all user data, including `storage.json`. `shareAppData(id)` exports only that app's public `storage.json`; private and secure storage remain excluded. `getInterfaceSettings()` reads the active interface's `Interface/<id>/settings.json` and returns `{}` for a missing or malformed file. `setInterfaceSettings()` accepts a JSON object only, limits its UTF-8 serialization to 64 KiB, and atomically replaces that file; the host derives the active interface path itself. `launcher.getAppInfo(id)` returns the app manifest, installation and update timestamps, and application/data size breakdown. Windows share actions copy their text/file payload to the clipboard.

Trusted launcher interfaces can also call `launcher.getRollbackInfo(id)`, `launcher.rollbackApp(id)`, and `launcher.deleteRollback(id)`. An update retains one previous app directory and source under `MiniApps/.runtime/rollback/by-id`. Rollback swaps source versions but deliberately does not roll back public, private, or secure data. `launcher.getAppPermissions(id)`, `launcher.setAppPermission(id, permission, state)`, and `launcher.resetAppPermissions(id)` manage manifest-declared permission decisions. These management methods are never available to mini-app JavaScript.

Backup APIs are reserved in the shared launcher contract, but native backup/restore file dialogs and restore execution are not implemented yet. Feature-detect `backup.restore` before presenting it in an interface.

## System APIs

Windows supports controlled `mini.network.request`, network status events, multiple-file and directory handles, clipboard read, native dialogs/toast, and validated external URL/file/settings opening. Network requests are allowlist-controlled and cookie-free. Directory paths are never returned to JavaScript; persisted directory paths remain in local runtime data.

Windows haptics and persistent notification scheduling/activation are unavailable and are reported as such by `mini.runtime.getCapabilities()`.

## Windows window controls

- Click an app card to open it in the main window.
- Right-click an app card for the launcher context menu, including **Open** and **Open in new window**.
- Middle-click an app card to open it in a new window.
- The main-window app view has a **← Back** button that returns to the launcher.
- If at least one additional app window is open, closing the main window hides it in the notification area instead of exiting. Double-click the tray icon, or select **Open**, to restore it. Select **Exit** in the tray menu to exit explicitly.

## Native top bar API

Each mini-app receives a native top bar. An interface-specific configuration can be placed in `Interface/<name>/appbar.js`; it calls `mini.ui.setTopBar(config)` after the page loads. The Windows host draws the bar and reserves its height above the WebView, so page content never overlaps it.

`config` supports `visible`, `height` (40–120 px), `paddingX`, `paddingY`, `titleFontSize`, `title`, `background`, `foreground`, `accent`, `showBack`, `backText`, `backButton`, and up to four `actions`. Colors use `#RRGGBB`. An action has `id`, `label`, and optional `accent`; handle its click in the mini-app with `mini.events.on('ui.topBarAction', handler)`.

The `backButton` object keeps the complete appearance of the back button in the interface layer: `radius` (0–48 px), `paddingX` (4–48 px), `background`, `hoverBackground`, `foreground`, `border`, `borderOpacity` (0–255), and `fontSize` (7–20). The Windows host renders these settings with its own lightweight control, rather than a system `Button`, so rounded corners do not leave a rectangular or black background.

## Windows taskbar title

Use `await mini.app.setWindowTitle('My mini-app')` to set the title of the active mini-app window. Windows displays this title in the taskbar, Alt+Tab, and the window caption. The launcher restores its own title when the mini-app is closed.
