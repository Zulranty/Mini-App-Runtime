# Mini App Runtime documentation

Mini App Runtime is a local-first host for HTML mini-apps on Android and Windows. A mini-app is a normal set of HTML, CSS, JavaScript, and assets; the native host adds a small, asynchronous `mini.*` bridge for platform features.

The project is designed for editable, offline-capable mini-apps rather than hosted web applications. It does not bundle Chromium: Android uses the system WebView and Windows uses the installed Microsoft Edge WebView2 Runtime.

## Quick Start

Build a small **Quick Start Notes** app, save a note, then reopen the app to
check that the note persists. The same ZIP works on Android and Windows.

### 1. Open MiniApps

If you already have MiniApps installed, open the launcher. To build a local
copy, run the command for your platform from the repository root:

| Platform | Command | File to install |
| --- | --- | --- |
| Windows | `Build\Scripts\BuildWindows.cmd` | `Output\Windows\MiniAppsSetup.exe` |
| Android | `Build\Scripts\BuildAndroid.cmd Local` | `Output\Android\MiniApps-local.apk` |

See [Requirements](#requirements) for build and runtime dependencies. On
Android, copy the APK to your device, install it and grant MiniApps access to
its shared folder when prompted.

### 2. Create the mini-app

Save these two UTF-8 files in a folder named `quick-start-notes`.

**manifest.json**

```json
{
  "id": "com.example.quickstart.notes",
  "name": "Quick Start Notes",
  "version": "1.0.0",
  "sdkVersion": 2,
  "entry": "index.html",
  "permissions": ["storage"]
}
```

**index.html**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Quick Start Notes</title>
</head>
<body>
  <h1>Quick Start Notes</h1>
  <label for="note">Note</label>
  <input id="note" disabled>
  <button id="save" type="button" disabled>Save</button>
  <p id="status" role="status"></p>

  <script>
    const note = document.querySelector('#note');
    const save = document.querySelector('#save');
    const status = document.querySelector('#status');

    async function restoreNote() {
      try {
        const permission = await mini.permissions.query('storage');
        if (permission === 'granted') {
          note.value = (await mini.storage.private.get('note')) ?? '';
        }
      } catch (error) {
        status.textContent = 'Could not load the note (' +
          (error.code ?? 'runtime_unavailable') + ').';
      } finally {
        note.disabled = false;
        save.disabled = false;
      }
    }

    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await mini.storage.private.set('note', note.value);
        status.textContent = 'Saved.';
      } catch (error) {
        status.textContent = 'Could not save the note (' +
          (error.code ?? 'runtime_unavailable') + ').';
      } finally {
        save.disabled = false;
      }
    });

    restoreNote();
  </script>
</body>
</html>
```

Open the page through MiniApps so the host can inject `mini.*`. On first
launch the example checks permission without opening a prompt. Pressing
**Save** supplies the gesture required for the host to request storage
access. Subsequent launches read the note once that access is granted.

### 3. Import and verify

1. From the directory containing `quick-start-notes`, run this in PowerShell:

   ```powershell
   Compress-Archive -Path .\quick-start-notes\manifest.json, .\quick-start-notes\index.html -DestinationPath .\quick-start-notes.zip
   ```

   The ZIP root must contain `manifest.json` and `index.html` directly.
2. On Android, copy the ZIP to a location you can select in the device's file
   picker. On either platform, open the launcher menu, choose **Add app** in
   the default interface, and select `quick-start-notes.zip`.
3. Open **Quick Start Notes**, type a note, and press **Save**. Confirm
   the storage prompt with **Allow** on Android or **Yes** on Windows,
   then wait for **Saved.**
4. Return to the launcher and reopen **Quick Start Notes**. The note should
   already be in the input field. Its private storage is local to each
   installation, so repeat the save-and-reopen check on each platform.

## Requirements

| Target | Build requirements | Runtime requirements |
| --- | --- | --- |
| Android | JDK 17+, Android SDK Platform 36, committed Gradle Wrapper | Android 7.0 (API 24) or later with a Chromium-based system WebView 98 or newer with WebMessageListener |
| Windows | .NET SDK 10+, Inno Setup 6+ | x64 .NET 10 Desktop Runtime and Microsoft Edge WebView2 Runtime |

The Gradle Wrapper downloads Gradle 8.14 on its first use. Windows restores NuGet packages when the local restore cache is absent, so the first build needs internet access.

Android release builds also require a permanent app signing keystore. Set
`MINIAPPS_ANDROID_KEYSTORE` to its path and provide
`MINIAPPS_ANDROID_STORE_PASSWORD`, `MINIAPPS_ANDROID_KEY_ALIAS`, and
`MINIAPPS_ANDROID_KEY_PASSWORD` through the build environment. The build fails
if any value is missing. The explicit `Local` mode uses automatic debug signing;
the default distribution build never falls back to it. Keep the
keystore and passwords outside this repository and back them up securely. A
different key cannot update an installed app signed by the original key. The
local certificate is stored by the SDK in the normal debug keystore; retaining
that keystore permits updates to earlier locally signed APKs.
Use `Build\Scripts\BuildAndroid.cmd Bundle` to build a release AAB with the
distribution key. The Android target is API 36. Shared-folder access is
required by the launcher and is subject to Google Play permission review.

## Documentation map

- [Architecture](architecture.md) — components, data flow, and repository layout.
- [Mini-app format](mini-app-format.md) — manifests, packaging, updates, permissions, network policy, and notifications.
- [Shared modules and Telegram](telegram.md) — drop-in libraries and setup for the personal-account Telegram mini-app.
- [Runtime API](runtime-api.md) — the `mini.*` bridge, feature detection, limits, and platform availability.
- [Local device presets](local-devices.md) — generic LAN discovery, endpoint capabilities, protocol and verification.
- [Using the launcher](launcher-management.md) — app cards, built-in apps, Telegram setup, and themes.
- [Package management](mini-app-management.md) — updates, rollback, and launcher permission APIs.
- [Launcher interface module](interface-module.md) — editable launcher interfaces and Windows app bars.
- [Security model](security-model.md) — trust boundaries, storage isolation, file capabilities, and network controls.
- [Release checklist](release-readiness.md) — distribution requirements and the historical September 2026 review.
- [Windows build details](windows-build.md) and [Windows distribution](windows-distribution.md) — publish layout, installer behavior, and updates.

## Runtime data locations

Android uses `/storage/emulated/0/MiniApps` for installed mini-apps and editable launcher interfaces. Android 11+ requires the system **All files access** permission for direct access to that shared folder.

Windows keeps application state in the chosen installation folder. `MiniApps/` contains installed mini-apps, `Interface/` contains launcher interfaces, `Config/` contains launcher configuration and permission decisions, and `Data/User/` contains private and secure user data. Public mini-app data is the portable `storage.json` file in the mini-app folder.

## Manifest reference

| Field | Required | Description |
| --- | --- | --- |
| `id` | Yes | Stable identifier. Use Latin letters, digits, dots, hyphens, and underscores. |
| `name` | Yes | Display name. |
| `version` | Yes | Semantic version used for update decisions. |
| `sdkVersion` | Yes | Mini-app SDK version (`1` or `2`). |
| `entry` | No | Relative HTML entry path; defaults to `index.html`. |
| `minRuntimeVersion` | No | Minimum runtime SemVer required to launch the app. |
| `description`, `author`, `icon` | No | Display metadata. `icon` is a relative PNG or JPG path. |
| `permissions` | No | Requested capabilities. |
| `network` | Required for controlled network access | Origin allowlist and opt-in network flags. |

Supported permissions are `storage`, `clipboard.write`, `clipboard.read`, `files.pick`, `files.save`, `files.directory`, `share`, `secureStorage`, `network`, `notifications`, `system.open`, `haptics`, and `telegram.session`.

## API quick reference

| Namespace | Purpose |
| --- | --- |
| `mini.app` | App metadata, close, launch parameters, and the Windows window title. |
| `mini.runtime` | Capabilities and feature detection. |
| `mini.storage` | Private JSON storage, public portable storage, schema versions, and atomic transactions. |
| `mini.permissions` | Query and request manifest-declared permissions. |
| `mini.secureStorage` | Encrypted, app-scoped secrets. |
| `mini.files` | File and directory capability handles, chunked reads and writes, and save dialogs. |
| `mini.network` | Controlled, allowlisted HTTP requests and normalized network status. |
| `mini.notifications` | Android notification scheduling. |
| `mini.clipboard`, `mini.share`, `mini.ui`, `mini.system` | Native clipboard, sharing, dialogs, top bar, and validated system opening. |
| `mini.events` | Navigation, permission, network, and lifecycle events. |

Every call is asynchronous and may reject with a stable error `code`. Use `mini.runtime.supports(name)` before presenting optional controls. See [Runtime API](runtime-api.md) for limits, errors, platform availability, and complete behavior.

## Update and sharing behavior

The runtime identifies an installed mini-app by `manifest.id`. Manual imports, packages scanned from the MiniApps folder, and bundled updates on both platforms accept the same version or a newer version. Updates keep public `storage.json` and its recovery copy. Invalid packages leave the active app in place. Sharing exports a self-contained HTML file or a ZIP of application code. Private and secure storage stay on the device.

## Launcher interfaces

Launcher interfaces are editable HTML/CSS/JavaScript packages. The active interface is selected in the launcher settings. Each interface contains `index.html` and may include `appbar.js` and `appbar.css` to configure a mini-app top bar. On Windows, the installer packages the interface and built-in mini-app directories from `DefaultContent/`; additional user interfaces and mini-apps survive installer updates.

## Repository layout

| Path | Purpose |
| --- | --- |
| `Code/Android/app/` | Kotlin Android host |
| `Code/Windows/` | .NET 10 WinForms and WebView2 host |
| `Code/Framework/shared/` | JavaScript bridges shared by both hosts |
| `DefaultContent/` | Built-in mini-apps and launcher themes for Windows and Android |
| `Build/` | Build configuration, scripts, and platform packaging files |
| `Cache/` | Re-creatable local build outputs and caches |
| `Output/` | Final distribution artifacts |
