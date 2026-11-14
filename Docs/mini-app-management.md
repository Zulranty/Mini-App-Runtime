# Package management

See [Using the launcher](launcher-management.md) for the app-card and theme controls.

## Install and update

Importing a package with the same `manifest.id` and version replaces the active
mini-app, which allows a corrected package to be delivered without a version
bump. Packages with an older version are rejected. Updates preserve public
`storage.json` and `storage.json.bak` on both platforms.

Both hosts apply bundled packages through the normal package installer
during startup. Android waits for shared-folder access. The installer
validates the ID and version, preserves app data and recovers interrupted
replacements. Android records consumption of scanned files and bundled
updates with the installation so restart can finish the same operation.

`refresh()` scans packages placed directly in `MiniApps`. Picker imports install
the selected package directly; the runtime does not retain a second source copy.

## Windows rollback and permission APIs

Trusted launcher interfaces on Android and Windows can call `launcher.getAppInfo(appId)` to obtain the selected app's manifest, installation and update timestamps, and application/data size breakdown. On Windows, trusted launcher interfaces can additionally call:

- `launcher.getRollbackInfo(appId)` — returns `{ available, currentVersion, previousVersion, createdAt }` when a retained version exists.
- `launcher.rollbackApp(appId)` — validates and swaps the active and retained app directories.
- `launcher.deleteRollback(appId)` — removes only the retained version.
- `launcher.getAppPermissions(appId)` — returns declared permissions with their `granted`, `denied`, or `prompt` state.
- `launcher.setAppPermission(appId, permission, state)` — changes a declared permission to `granted`, `denied`, or `prompt`.
- `launcher.resetAppPermissions(appId)` — restores all permission decisions to `prompt`.

Rollback preserves public, private, and secure user data. This avoids accidental data loss, but an older app version can be incompatible with current data and must handle its own migration. Only one previous version is retained. Close all windows of a Windows mini-app before updating, rolling back, or deleting it.

Android uses equivalent repository-level rollback metadata and swaps, but these launcher methods are not yet exposed to its custom launcher interface. Do not show rollback controls without feature detection.

## Permission decisions

The launcher permission manager displays all manifest-declared permissions, including `network`, `notifications`, `clipboard.read`, `files.directory`, `system.open`, and `haptics`. When an app update adds one, its decision is left at `prompt`; when an update removes one, the stored decision is deleted. Decisions remain isolated by `manifest.id`.

Windows stores permissions by stable app ID. When migrating a legacy
display-name record, the host preserves denials and requests fresh consent
for grants.

Deleting an Android mini-app cancels its scheduled notifications and clears its folder aliases, notification records, permission decisions, public source, and private data. A system folder grant is kept while another alias or open runtime still uses it. Updating an app with the same `manifest.id` preserves its notification records.

## Reserved backup and restore APIs

`createBackup`, `inspectBackup`, and `restoreBackup` are reserved. The
current hosts have no complete backup or restore flow. Keep those controls
hidden until the host reports support for `backup.restore`.

The planned `miniapps-backup` ZIP format uses a version 1
`backup-manifest.json` and per-app entries for source, public data, private
data, and permission decisions. Restore is planned to be atomic per app,
with `replace` and `skip` choices after checking conflicts (`not_installed`,
`same_version`, `backup_newer`, `installed_newer`). The trusted launcher
would own selection and confirmation. Secure storage is excluded.
