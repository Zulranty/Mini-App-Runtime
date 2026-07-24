# Managing mini-apps

## Application information

`launcher.getAppInfo(appId)` is available to Android and Windows launcher interfaces. It returns the selected app's manifest, installation and update timestamps, and application and data sizes.

The runtime uses the same launcher contract on Android and Windows: `list`, `open`, `refresh`, `importApp`, `deleteApp`, `shareApp`, `shareAppData`, and `getSettingsInfo`; Windows additionally supports `openNewWindow`. The interface manager provides `listInterfaces`, `selectInterface(id)`, `importInterface()`, `getInterfaceSettings()`, and `setInterfaceSettings(settings)`. Interface settings are a JSON object in the active interface's `settings.json`, limited to 64 KiB and written atomically; a missing or corrupted file reads as `{}`.

On Android, the working folder is `/storage/emulated/0/MiniApps`. The runtime does not import or migrate data from any previous application folder.

Source ZIP and HTML files are not kept after installation. Automatic scanning processes packages placed directly in `MiniApps`, while the system picker installs the selected package without creating a second copy. Installation is identified by `manifest.id`, accepts only a newer version, and preserves public `storage.json` on update.

The app-card menu can delete or share an app and share its public `storage.json`. App sharing creates a single HTML file only for a self-contained HTML app with an embedded manifest; otherwise it creates a ZIP containing the app code. User data, including `storage.json`, is excluded. Data sharing exports only public `storage.json`. Deletion also clears private storage and stored permission decisions. Android uses the system Sharesheet with a `content://` FileProvider; Windows copies a file to the clipboard for pasting into Explorer or another application. Windows `mini.share.text()` and `mini.share.file()` also copy their text or file payload to the clipboard. Private storage is never exported.

## Launcher interfaces

On Android, interfaces reside in `MiniApps/Interface/<interface-id>/`; on Windows, they reside in `Interface/<interface-id>/` beside `MiniApps.exe`. Select the active interface in **Settings → Interface**; it is used by both the launcher and mini-app app bars. The built-in `default` contains only `index.html`, with its CSS and launcher JavaScript embedded. HTML and ZIP files placed directly in `Interface/` are scanned as new interfaces; the same import is available from **Add interface**. Folder and ZIP interfaces may contain additional files. An interface-specific mini-app app bar is stored beside the interface as `appbar.css` and `appbar.js`.

If the active interface is removed manually, the runtime selects and saves the first valid interface alphabetically on the next launch. A valid interface folder contains `index.html`.
