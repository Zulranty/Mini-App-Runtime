# Mini-app format

On Android and Windows, the launcher imports ZIP archives and single HTML
files. The file picker accepts those files. To use an unpacked app, place
its folder directly in the runtime's `MiniApps` directory with the manifest
at the folder root. The directory is `/storage/emulated/0/MiniApps` on
Android and `MiniApps/` beside `MiniApps.exe` on Windows.

## Folder and ZIP layout

An unpacked mini-app has this layout. When you create a ZIP, archive the
contents so `manifest.json` is at the ZIP root.

```text
example-mini-app/
├── manifest.json
├── index.html
├── app.js
├── style.css
└── assets/
```

Minimal `manifest.json`:

```json
{
  "id": "com.example.demo",
  "name": "Demo App",
  "version": "1.0.0",
  "sdkVersion": 1,
  "entry": "index.html"
}
```

Supported fields:

```text
id
name
version
sdkVersion
minRuntimeVersion
entry
description
author
icon
permissions
network
```

Shared JavaScript libraries live separately in `MiniApps/Modules/<id>/index.js`.
The `Modules` directory is reserved and is skipped by the app scanner.
Apps opt in by calling `mini.modules.load(id)`. Declare `telegram.session`
when an app offers shared Telegram sign-in. Optional integrations can wait
until the user opens their Telegram settings or selects Sync.
See [Shared modules and Telegram](telegram.md).

Supported permissions:

```text
storage
clipboard.write
files.pick
files.save
share
secureStorage
network
notifications
clipboard.read
files.directory
system.open
haptics
local.peers
telegram.session
```

The `icon` field can point to a PNG/JPG file inside the mini-app folder:

```json
{
  "icon": "assets/icon.png"
}
```

Paths must be relative, without `..`, without absolute paths and without going beyond the mini-app folder.

## Importing and updating ZIP packages

The installer uses `manifest.id` to identify the app. For example, on a
fresh installation a package whose ID is `com.example.demo` is installed
under `MiniApps/com.example.demo/`, even if its ZIP is named `demo.zip`.

On update, the installer finds the existing folder by manifest ID and keeps
that folder. It accepts the same or a newer SemVer version and preserves
`storage.json` and `storage.json.bak`. An older or invalid package leaves the
installed app in place. Close any open windows of the app before updating it
on Windows.

The picker leaves the selected ZIP at its original location. If you place
the ZIP directly in `MiniApps` and scan that directory, the host removes the
ZIP after a successful import. Sharing creates a new package from the
installed app's code and excludes user data.

## Single-file HTML

One HTML file can contain manifest within itself:

```html
<script type="application/miniapp+json">
{
  "id": "com.example.hsv",
  "name": "HSV Editor",
  "version": "1.0.0",
  "sdkVersion": 1,
  "description": "Single-file HSV color editor",
  "permissions": ["storage", "clipboard.write"]
}
</script>
```

`entry` can be omitted. During installation, runtime will name the HTML file based on the `name` field of the manifest: for example, `HSV Editor.html`, and write this name to `entry`. Invalid characters for the file name are replaced with `_`.

For example, the HTML above is installed as:

```text
MiniApps/com.example.hsv/
├── manifest.json
└── HSV Editor.html
```

## Localized mini-app packages

Keep translation dictionaries inside the mini-app package. Use one HTML page
and select its dictionary using `preferred` from `await mini.locale.get()`.
Set the document's `lang` to the chosen language. All languages share the same
app ID, permissions, version, storage and Telegram connection. Use the manifest
to translate the name and description displayed by the launcher:

```json
{
  "id": "com.example.notes",
  "name": "Notes",
  "version": "1.0.0",
  "sdkVersion": 2,
  "entry": "index.html",
  "translations": {
    "ru": { "name": "Заметки" }
  }
}
```

`translations` is optional and works in ZIP manifests and embedded manifests.
Its supported keys are `en` and `ru`. Each translation contains `name`,
`description`, or both. A missing field uses its top-level value. Translated
names and descriptions must be nonblank strings of at most 256 and 1024
characters, respectively. The top-level `entry` determines the page for
every language.

Keep translated UI text separate from user content. Bundle every dictionary
with the page so switching works offline. Importing an update with the same
app ID preserves its data.

## HTML without manifest

When importing an HTML file without an embedded manifest, the launcher can ask you to supply its metadata.

The dialog accepts these fields:

- App ID
- Name
- Version
- Description
- Author
- Permissions

After confirmation, the file is installed as a regular mini-app:

```text
MiniApps/<app-id>/
├── manifest.json
└── <application name>.html
```

The dialog validates the app ID, required fields and permissions before installation.

## Storage

`mini.storage.*` is private by default.

Public data is written explicitly via `mini.storage.public.*` to the file:

```text
MiniApps/<mini-app folder>/storage.json
```

## System permissions and network policy

Alongside the existing permissions, manifests may declare `network`, `notifications`, `clipboard.read`, `files.directory`, `system.open`, and `haptics`. New permissions are prompted after an update and are never granted automatically.

Controlled HTTP requests require both the `network` permission and an explicit allowlist:

```json
{
  "permissions": ["network"],
  "network": {
    "allow": ["https://api.example.com", "https://*.example.com"],
    "allowHttp": false,
    "allowSubdomains": false,
    "allowLocalNetwork": false
  }
}
```

Only exact origins and leading host wildcards are accepted. `*.example.com` does not include `example.com`. HTTP and local/private addresses require their corresponding explicit flags. The policy applies only to `mini.network.request`, not browser `fetch`.

## Notifications

Android mini-apps may declare `notifications` and schedule a one-time notification with `at`, a daily/weekly local-time schedule, or an `interval` from 15 minutes to seven days. Notification payloads must be JSON and are limited to 16 KiB. Windows declares the same permission for manifest compatibility but reports notification scheduling unavailable through capabilities.

## Discovery-only local device policy (1.5.0)

`network.discoveryServices` is an optional list of up to eight generic service names matching `[a-z][a-z0-9-]{0,47}`. A discovery policy requires the `network` permission and both `allowHttp: true` and `allowLocalNetwork: true`. `network.allow` may be empty when valid discovery services are declared; ordinary `network.request` continues to require an allowlisted origin. This creates no wildcard permission to arbitrary LAN URLs. See [Local device presets](local-devices.md).
