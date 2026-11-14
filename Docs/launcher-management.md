# Using the launcher

For the update rules and the Windows rollback and permission APIs, see
[Package management](mini-app-management.md).

## Application information

`launcher.getAppInfo(appId)` is available to Android and Windows launcher interfaces. It returns the selected app's manifest, installation and update timestamps, and application and data sizes.

Both hosts support these launcher operations: `list`, `open`, `refresh`, `importApp`, `deleteApp`, `shareApp`, `shareAppData`, and `getSettingsInfo`; Windows additionally supports `openNewWindow`. The interface manager provides `listInterfaces`, `selectInterface(id)`, `importInterface()`, `getInterfaceSettings()`, and `setInterfaceSettings(settings)`. Interface settings are a JSON object in the active interface's `settings.json`, limited to 64 KiB and written atomically; a missing or corrupted file reads as `{}`.

**Settings → About** shows the installed MiniApps version on Android and Windows. Launcher interfaces read the `version` field returned by `await launcher.getSettingsInfo()`.

On Android, the working folder is `/storage/emulated/0/MiniApps`. The runtime does not import or migrate data from any previous application folder.

Choose **Add app** to import a ZIP or HTML file. For the exact package layout
and scan behavior, see [Mini-app format](mini-app-format.md).

## Built-in mini-apps on Android

The Android APK includes the Android-compatible built-in mini-apps and the Telegram shared module. After a fresh install or an APK update, open MiniApps and grant file access if prompted. MiniApps applies the bundled packages before showing the app list. This includes Shopping List, Unofficial Telegram and Telegram Cloud. If the installed mini-app has a higher version, MiniApps keeps it. A failed package is retried when the launcher next starts.

Install the new APK over the existing MiniApps installation to retain private and secure storage. MiniApps updates each matching app in its existing folder and retains its public data. All languages of an app share its ID and data.

The app-card menu can delete or share an app and share its public `storage.json`. App sharing creates a single HTML file only for a self-contained HTML app with an embedded manifest; otherwise it creates a ZIP containing the app code. User data, including `storage.json`, is excluded. Data sharing exports only public `storage.json`. Deletion also clears private storage and stored permission decisions. Android uses the system Sharesheet with a `content://` FileProvider; Windows copies a file to the clipboard for pasting into Explorer or another application. Windows `mini.share.text()` and `mini.share.file()` also copy their text or file payload to the clipboard. Private storage is never exported.

## Install Telegram

Open **Settings → Telegram** in the launcher and choose **Install Telegram**
or **Update Telegram**. Both builds carry the package files. MiniApps
shows progress while installing the shared module in
`MiniApps/Modules/telegram` and installing or updating **Unofficial Telegram**.
The installer keeps the saved Telegram account. The bundled client is used
for Telegram sign-in. When a newer installed client causes the import to be
skipped, the launcher reports that outcome and leaves the shared module as
it was. This section also contains
**Telegram test server** and **Save Telegram login log to file** on both
platforms. Both settings are stored per installation and are off by default.
The server choice applies when you next open Unofficial Telegram directly.

The **Unofficial Telegram** app card shows the client version. Use the Telegram
settings action to reinstall the included module and client when needed.

Both built-in launcher interfaces include **Telegram** in **Settings**.
Custom interfaces can add the Telegram controls using the launcher API.

After successful installation, choose **Yes** to restart MiniApps immediately
or **No** to keep working. Custom launcher interfaces can use
`launcher.hasTelegramClient()` to label the action in settings and
`launcher.installTelegram()` to open the platform's installer with progress
and restart confirmation. Use `launcher.mountTelegramSettings(container)`
to add the two switches and the login-log viewer to a custom Telegram settings panel.

## Launcher interfaces

On Android, interfaces reside in `MiniApps/Interface/<interface-id>/`; on Windows, they reside in `Interface/<interface-id>/` beside `MiniApps.exe`. Select the active interface in **Settings → Interface**; it is used by both the launcher and mini-app app bars. The built-in `default` contains only `index.html`, with its CSS and launcher JavaScript embedded. HTML and ZIP files placed directly in `Interface/` are scanned as new interfaces; the same import is available from **Add interface**. Folder and ZIP interfaces may contain additional files. An interface-specific mini-app app bar is stored beside the interface as `appbar.css` and `appbar.js`.

If the active interface is removed manually, Android selects Default and Windows selects the first valid interface alphabetically on the next launch. A valid interface folder contains `index.html`.
