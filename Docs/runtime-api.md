# Runtime API v2

Runtime version is `1.4.0`; SDK version 2 is supported. All methods return `Promise` and reject with an object carrying a stable `code`.

## Navigation

`mini.events.on('navigation.backRequested', handler)` receives `{ handled() }`. Android system Back/gesture, Windows Escape, native top-bar Back and appbar Back share this route. The host performs the default action after 350 ms when no handler marks the event handled; repeated requests are coalesced. Interception is enabled by default and can be changed with `mini.navigation.setBackEnabled(boolean)`. `mini.navigation.getState()` returns `{ backEnabled }`.

## Capabilities

`mini.runtime.getCapabilities()` returns `runtimeVersion`, `sdkVersion`, `platform`, methods, feature flags and limits. `mini.runtime.supports(name)` accepts a method, feature or event name. Mini-app manifests may declare `minRuntimeVersion` as SemVer. Installation remains possible, but launch is blocked with `runtime_version_too_old` when the runtime is older.

Both `version` and `minRuntimeVersion` use SemVer (`major.minor.patch`, optional prerelease and build metadata). The runtime compares numeric prerelease identifiers according to SemVer rather than using lexical string comparison.

## Application information

`mini.app.getAppInfo()` returns all available manifest fields of the current mini-app, plus ISO-8601 `installedAt` and `updatedAt` timestamps. `appSizeBytes` excludes persistent data; `dataSizeBytes` includes public, private, and secure runtime storage. The separate `publicDataSizeBytes`, `privateDataSizeBytes`, and `secureDataSizeBytes` fields provide a size breakdown.

## Storage

Both `mini.storage.private` and `mini.storage.public` provide `getMany`, `setMany`, `getSchemaVersion`, `setSchemaVersion`, and `getUsage`. Schema version starts at 0. Use `mini.storage.transaction({ scope, operations })` for an atomic set/remove/clear/schema update; callback transactions are intentionally unsupported. Public data is written to a flushed temporary file, then atomically replaced; `storage.json.bak` is used for recovery. Corrupt primary and backup data return `storage_corrupted` without silently clearing data.

## Permissions and secrets

`mini.permissions.query`, `request`, and `openSettings` use `granted`, `denied`, `prompt`, `not_declared`, and `unsupported`. A permission must be declared in the manifest. `permissions.changed` is emitted only to the requesting app. `secureStorage` requires the manifest permission of the same name and exposes `get`, `set`, `remove`, `keys`, and `clear`. Android encrypts it with an Android Keystore key; Windows uses user-scoped DPAPI. It is keyed by manifest ID, is not public storage, is not shared, and is not in ordinary backups.

## Events and errors

Events: `navigation.backRequested`, `permissions.changed`, `network.statusChanged`, `app.launchParamsChanged`, `storage.restored`, `app.updated`, `app.rolledBack`. Stable system errors include `feature_unavailable`, `user_gesture_required`, `network_unavailable`, `network_permission_denied`, `network_url_not_allowed`, `network_invalid_url`, `network_timeout`, `network_request_failed`, `network_request_too_large`, `network_response_too_large`, `network_redirect_blocked`, `network_tls_failed`, `notification_permission_denied`, `notification_payload_too_large`, `directory_not_found`, `file_not_found`, `file_too_large`, `file_exists`, `system_url_not_allowed`, and `system_no_handler`.

## System APIs (stage 2)

New manifest permissions are `network`, `notifications`, `clipboard.read`, `files.directory`, `system.open`, and `haptics`. They use the existing `mini.permissions.query()` and `mini.permissions.request()` flow and begin in `prompt` after an update. Native alert, confirm, prompt and toast require no permission.

`mini.network.request(options)` is the controlled HTTP API. It requires `network` and a `network.allow` manifest list containing exact HTTPS origins or `*.example.com` subdomain patterns. HTTPS is the default; HTTP, local network addresses, and subdomains of a non-wildcard allowlist entry need their explicit manifest flags. Every redirect is checked again. The request limit is 10 MiB, response limit is 20 MiB, default timeout is 30 seconds, and at most five redirects are followed. Browser `fetch` remains unchanged and is **not** governed by this allowlist.

`mini.network.getStatus()` returns only `{ online, type, metered }`; it never exposes network names, addresses, or hardware identifiers. Android and Windows provide the controlled request API and status. Both emit `network.statusChanged` only when this normalized state changes and unregister their system listener when the mini-app closes. Windows currently reports `type: "unknown"` and `metered: false` because the WinForms host does not expose a stable richer classification.

File handles remain opaque and scoped to one mini-app. Both hosts support `files.pickMultiple`, `files.getInfo`, `files.readChunk`, `files.readTextChunk`, and `files.releaseMany`; chunks are bounded to 1 MiB. Both hosts also support user-selected directory handles: `pickDirectory`, `listDirectory`, `openInDirectory`, `createInDirectory`, `writeChunk`, `flush`, `persistDirectory`, `restoreDirectory`, and `forgetDirectory`. Directory paths must be relative and cannot contain traversal segments. The legacy whole-file methods retain their existing 5 MiB guard.

Windows supports the same directory-handle methods. A persisted directory stores its host path privately under the user's runtime data; JavaScript receives only a new opaque directory ID after restoration. Chunk writes append at most 1 MiB and flush synchronously before resolving.

Android supports `mini.notifications.requestPermission`, `schedule`, `cancel`, `get`, `list`, and `cancelAll`. `requestPermission` uses Android's `POST_NOTIFICATIONS` prompt on Android 13+. Records are private to the manifest ID and retained after the mini-app runtime closes. Supported schedules are one-time ISO-8601 `at` timestamps, daily/weekly local-time schedules, and `interval` schedules from 15 minutes to seven days. Records are re-armed after device boot. Android alarm delivery is best-effort and system power policies can delay it. Windows notifications remain feature-unavailable.

`clipboard.readText()` requires `clipboard.read`; it returns text or `null`. `ui.alert`, `ui.confirm`, `ui.prompt`, and `ui.toast` use native UI. `haptics.*` requires `haptics` and is supported on Android only. `system.canOpenUrl`, `openUrl`, `openFile`, and `openSettings` require `system.open`; URL opening is delegated to the operating system and permits only `https`, `http`, `mailto`, `tel`, and (Android) `geo`.

Use `mini.runtime.getCapabilities()` or `mini.runtime.supports(name)` before optional APIs. Calls for an unavailable feature reject with a stable error rather than silently succeeding.

File pickers, clipboard reads, permission prompts, and external opening require a recent native user gesture on Android and Windows. Calls made outside that window reject with `user_gesture_required`.

`mini.app.getLaunchParams()` returns the current launch context. Android returns `{ reason: "notification", notificationId, payload }` after a notification tap and emits `app.launchParamsChanged` for a running activity. Payload is JSON-only, limited to 16 KiB, and host-owned. Windows currently returns `{ reason: "normal" }` because Windows notification activation is not implemented.

## Platform availability

| Capability | Android | Windows |
| --- | --- | --- |
| Controlled `network.request` and `network.statusChanged` | Available | Available; status type is `unknown` |
| Persistent notifications | Available: once, daily, weekly, interval | Unavailable |
| File and directory handles | Available | Available |
| Clipboard read, dialogs, toast, system open | Available | Available |
| Haptics | Available | Unavailable |
| Notification launch parameters | Available | Unavailable |

Always use `mini.runtime.supports(name)` or `getCapabilities()` instead of relying on this table.

`app.updated`, `app.rolledBack`, and `storage.restored` are reserved lifecycle events: applications should feature-detect them until the launcher emits them on both platforms.
