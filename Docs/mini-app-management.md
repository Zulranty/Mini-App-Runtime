# Managing mini-apps

The launcher API reserves `createBackup`, `inspectBackup`, `restoreBackup`, permission-management, and rollback methods in the common JS contract. Backup archives use the `miniapps-backup` ZIP format version 1 with `backup-manifest.json` and per-app manifest/source/public/private/permission entries. Restore is specified as atomic per application and only supports `replace` and `skip`; it must inspect conflicts (`not_installed`, `same_version`, `backup_newer`, `installed_newer`) before changing data.

## Implemented launcher management APIs

Importing a package with the same `manifest.id` and version replaces the active
mini-app, which allows a corrected package to be delivered without a version
bump. Packages with an older version are rejected. Updates preserve public
`storage.json`.

`refresh()` scans packages placed directly in `MiniApps`. Picker imports install
the selected package directly; the runtime does not retain a second source copy.

Trusted launcher interfaces on Android and Windows can call `launcher.getAppInfo(appId)` to obtain the selected app's manifest, installation and update timestamps, and application/data size breakdown. On Windows, trusted launcher interfaces can additionally call:

- `launcher.getRollbackInfo(appId)` — returns `{ available, currentVersion, previousVersion, createdAt }` when a retained version exists.
- `launcher.rollbackApp(appId)` — validates and swaps the active and retained app directories.
- `launcher.deleteRollback(appId)` — removes only the retained version.
- `launcher.getAppPermissions(appId)` — returns declared permissions with their `granted`, `denied`, or `prompt` state.
- `launcher.setAppPermission(appId, permission, state)` — changes a declared permission to `granted`, `denied`, or `prompt`.
- `launcher.resetAppPermissions(appId)` — restores all permission decisions to `prompt`.

Rollback preserves public, private, and secure user data. This avoids accidental data loss, but an older app version can be incompatible with current data and must handle its own migration. Only one previous version is retained in `MiniApps/.runtime/rollback/<appId>/` with `miniapps-rollback` metadata format version 1.

Android uses equivalent repository-level rollback metadata and swaps, but these launcher methods are not yet exposed to its custom launcher interface. Do not show rollback controls without feature detection.

The trusted launcher UI—not a mini-app—owns backup selection, restore approval, private-data warning, permission management, and rollback confirmation. Secure storage is deliberately not backed up. The current host implementation exposes the contract but does not yet expose a complete native backup/restore dialog flow; callers must feature-detect `backup.restore`.

## Stage 2 permissions

The launcher permission manager displays all manifest-declared permissions, including `network`, `notifications`, `clipboard.read`, `files.directory`, `system.open`, and `haptics`. When an app update adds one, its decision is left at `prompt`; when an update removes one, the stored decision is deleted. Decisions remain isolated by `manifest.id`.

Deleting an Android mini-app cancels its scheduled notifications and removes its persisted directory grants, notification records, permission decisions, public source, and private data. Updating an app with the same `manifest.id` preserves its notification records.
