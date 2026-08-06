# Mini-app format

Mini-app can be placed in `/storage/emulated/0/MiniApps` in several ways:

- ZIP archive.
- Ready folder.
- A single HTML file with a built-in manifest.
- A regular HTML file without manifest, with manual data entry via popup.

## Folder or ZIP

The structure of a regular mini-app:

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
```

The `icon` field can point to a PNG/JPG file inside the mini-app folder:

```json
{
  "icon": "assets/icon.png"
}
```

Paths must be relative, without `..`, without absolute paths and without going beyond the mini-app folder.

## ZIP update logic

If `demo.zip` is found, it is installed to:

```text
MiniApps/demo/
```

After successful installation, the original ZIP is not saved: the application is deployed in its own folder. When sent, the launcher creates a new ZIP from the application files, excluding user data.

If the `demo/` folder already exists, the launcher reads manifest from the folder and from the ZIP:

- if `id` matches and the version in ZIP is newer, the folder is updated;
- if the version is the same or older, the installed application and the saved source do not change;
- if the ZIP is broken or the manifest is invalid, the ZIP remains in place.

When updating, the public `storage.json` is saved.

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

For example `hsv-editor.html` will be set as:

```text
MiniApps/hsv-editor/
├── manifest.json
└── HSV Editor.html
```

## HTML without manifest

If the launcher finds `.html` without embedded manifest, it shows the “Unclear HTML” popup.

In popup you can enter:

- App ID
- Name
- Version
- Description
- Author
- Permissions

After confirmation, the file is installed as a regular mini-app:

```text
MiniApps/<html-file-name>/
├── manifest.json
└── <application name>.html
```

Popup validates `id`, required fields and permissions before installation.

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
