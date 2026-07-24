# Mini App Runtime documentation

Mini App Runtime is a local-first host for HTML mini-apps on Android and Windows. A mini-app is a normal set of HTML, CSS, JavaScript, and assets; the native host adds a small, asynchronous `mini.*` bridge for platform features.

The project is designed for editable, offline-capable mini-apps rather than hosted web applications. It does not bundle Chromium: Android uses the system WebView and Windows uses the installed Microsoft Edge WebView2 Runtime.

## Start here

1. Build the platform you need from the repository root:

   ```bat
   build\Scripts\BuildWindows.cmd
   build\Scripts\BuildAndroid.cmd
   ```

   `BuildWindows.cmd` produces `Output/Windows/MiniAppsSetup.exe`; `BuildAndroid.cmd` produces `Output/Android/MiniApps.apk`. The scripts do not build an Android debug APK.

2. Create a folder containing `manifest.json` and `index.html`.

   ```text
   hello-mini-app/
   |- manifest.json
   `- index.html
   ```

3. Install the folder or its ZIP archive in the launcher. On Android, packages can also be placed in `/storage/emulated/0/MiniApps`.

## Requirements

| Target | Build requirements | Runtime requirements |
| --- | --- | --- |
| Android | JDK 17+, Android SDK Platform 35, committed Gradle Wrapper | Android 7.0 (API 24) or later and Android System WebView |
| Windows | .NET SDK 8+, Inno Setup 6+ | x64 .NET Desktop Runtime 8+ and Microsoft Edge WebView2 Runtime |

The Gradle Wrapper downloads Gradle 8.14 on its first use. Windows restores NuGet packages when the local restore cache is absent, so the first build needs internet access.

## Documentation map

- [Architecture](architecture.md) — components, data flow, and repository layout.
- [Mini-app format](mini-app-format.md) — manifests, packaging, updates, permissions, network policy, and notifications.
- [Runtime API](runtime-api.md) — the `mini.*` bridge, feature detection, limits, and platform availability.
- [Launcher management](launcher-management.md) — application lifecycle, sharing, rollback, and trusted launcher operations.
- [Launcher interface module](interface-module.md) — editable launcher interfaces and Windows app bars.
- [Security model](security-model.md) — trust boundaries, storage isolation, file capabilities, and network controls.
- [Windows build details](windows-build.md) and [Windows distribution](windows-distribution.md) — publish layout, installer behavior, and updates.

## Mini-app example

```json
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "sdkVersion": 2,
  "entry": "index.html",
  "permissions": ["storage"]
}
```

```html
<!doctype html>
<meta charset="utf-8">
<title>Hello</title>
<button id="increment">Count: 0</button>
<script>
  const button = document.querySelector('#increment');
  let count = 0;

  button.addEventListener('click', async () => {
    count += 1;
    await mini.storage.set('count', count);
    button.textContent = `Count: ${count}`;
  });
</script>
```

All bridge calls return a `Promise`. Call `mini.runtime.supports(name)` or `mini.runtime.getCapabilities()` before using optional platform features.

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

Supported permissions are `storage`, `clipboard.write`, `clipboard.read`, `files.pick`, `files.save`, `files.directory`, `share`, `secureStorage`, `network`, `notifications`, `system.open`, and `haptics`.

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

The runtime identifies an installed mini-app by `manifest.id`. A package with the same ID updates an existing app only when its version is newer; public `storage.json` is retained. Invalid packages do not replace the active app. Sharing exports either a self-contained HTML file or a ZIP of application code; private and secure storage are never exported.

## Launcher interfaces

Launcher interfaces are editable HTML/CSS/JavaScript packages. The active interface is selected in the launcher settings. Each interface contains `index.html` and may include `appbar.js` and `appbar.css` to configure a mini-app top bar. On Windows, the installer packages the interface and built-in mini-app directories from `DefaultContent/`; additional user interfaces and mini-apps survive installer updates.

## Repository layout

| Path | Purpose |
| --- | --- |
| `Code/Android/app/` | Kotlin Android host |
| `Code/Windows/` | .NET 8 WinForms and WebView2 host |
| `Code/Framework/shared/` | JavaScript bridges shared by both hosts |
| `DefaultContent/` | Built-in mini-apps and interfaces packaged for Windows |
| `Build/` | Build configuration, scripts, and platform packaging files |
| `Cache/` | Re-creatable local build outputs and caches |
| `Output/` | Final distribution artifacts |
