# Runtime API v2

Runtime version is `1.5.25`; SDK version 2 is supported. All methods return `Promise` and reject with an object carrying a stable `code`.

`mini.modules.load(id)` loads a classic script from `MiniApps/Modules/<id>/index.js` for ordinary mini-apps. The Unofficial Telegram provider loads its Telegram module from the host bundle.
Check `typeof mini.modules?.load === 'function'` when supporting older hosts.
See [Shared modules and Telegram](telegram.md) for the module layout and trust boundary.

Use `mini.functions.call(method, params)` to call a native function
registered for the current app. Check `mini.runtime.supports(method)`
for optional functions. The host registers functions based on the
installed app ID and its permissions.

### Telegram

A mini-app declaring `telegram.session` calls
`mini.functions.call('telegram.connect', { reauthenticate: false })`
from a user gesture. If necessary, the host opens the bundled Unofficial
Telegram sign-in screen. After sign-in, the requesting app receives the
saved record after native consent. Cancellation rejects with
`operation_cancelled`. Use `reauthenticate: true` to reopen sign-in.

`mini.functions.call('telegram.restoreSaved')` returns a previously
approved record, or `null` when the app needs consent or the session
is missing. The selected Cloud channel uses
`mini.functions.call('telegramCloud.getSavedChannel')` and
`mini.functions.call('telegramCloud.rememberChannel', { id })`.

The Telegram module acquires an exclusive connection with
`telegram.acquire` and an owner token, then calls `telegram.release`
after disconnecting. A busy connection returns `telegram_session_busy`.
The acquire result gives the persisted wait deadline in Unix milliseconds.
`telegram.setWaitUntil` extends it. The Cloud integration passes that
deadline to its active stream sources. Closing the WebView releases its
lease. Standalone Unofficial Telegram also registers
`telegram.acquireTest` for the separate test environment.

The provider's `telegram.getSettings` returns `{ testServer, writeLoginLog }`.
The provider uses `telegram.finishSignIn` after saving the session and
disconnecting during shared sign-in. It also registers
`telegram.setCodeCaptureProtection` for its service chat. Android 14 and
later emit `telegram.screenCaptured` if the OS detects a screenshot.
The provider and Cloud register `telegram.serviceNotices` for the
account's encrypted service notices. See [Telegram](telegram.md).

## Navigation

`mini.events.on('navigation.backRequested', handler)` receives `{ handled() }`. Android system Back/gesture, Windows Escape, native top-bar Back and appbar Back share this route. The host performs the default action after 350 ms when no handler marks the event handled; repeated requests are coalesced. Interception is enabled by default and can be changed with `mini.navigation.setBackEnabled(boolean)`. `mini.navigation.getState()` returns `{ backEnabled }`.

## Capabilities

`mini.runtime.getCapabilities()` returns `runtimeVersion`, `sdkVersion`, `platform`, methods, feature flags and limits. `mini.runtime.supports(name)` accepts a method, feature or event name. Mini-app manifests may declare `minRuntimeVersion` as SemVer. Installation remains possible, but launch is blocked with `runtime_version_too_old` when the runtime is older.

Both `version` and `minRuntimeVersion` use SemVer (`major.minor.patch`, optional prerelease and build metadata). The runtime compares numeric prerelease identifiers according to SemVer rather than using lexical string comparison.

## Application information

`mini.app.getAppInfo()` returns app metadata, using the selected localized name and entry when available, plus ISO-8601 `installedAt` and `updatedAt` timestamps. `appSizeBytes` excludes persistent data; `dataSizeBytes` includes public, private, and secure runtime storage. The separate `publicDataSizeBytes`, `privateDataSizeBytes`, and `secureDataSizeBytes` fields provide a size breakdown.

`await mini.locale.get()` returns `{ preferred, resolved }`. `preferred` is the
launcher language at the start of the mini-app. `resolved` is the matched
package language, or `null` for a legacy package without localized entries.
The same object is available as `locale` in `mini.app.getLaunchParams()`.
Apps can use `preferred` to choose their own dictionary. A running mini-app
keeps its launch language until it is reopened.

## Storage

Both `mini.storage.private` and `mini.storage.public` provide `getMany`, `setMany`, `getSchemaVersion`, `setSchemaVersion`, and `getUsage`. Schema version starts at 0. Use `mini.storage.transaction({ scope, operations })` for an atomic set/remove/clear/schema update; callback transactions are intentionally unsupported. Public data is written to a flushed temporary file, then atomically replaced; `storage.json.bak` is used for recovery. Corrupt primary and backup data return `storage_corrupted` without silently clearing data.

## Permissions and secrets

`mini.permissions.query`, `request`, and `openSettings` use `granted`, `denied`, `prompt`, `not_declared`, and `unsupported`. A permission must be declared in the manifest. `permissions.changed` is emitted only to the requesting app. `secureStorage` requires the manifest permission of the same name and exposes `get`, `set`, `remove`, `keys`, and `clear`. Android encrypts it with an Android Keystore key; Windows uses user-scoped DPAPI. It is keyed by manifest ID, is not public storage, is not shared, and is not in ordinary backups.

## Runtime logs

`await mini.logs.write(event, fields?)` appends a JSON line to the host's
central `miniapps.jsonl` and returns `{ path }`. MiniApps adds the UTC
timestamp, platform, app ID and app version. The file is in `Data/User/Logs`
under the Windows installation or `Documents/MiniApps/Logs` in Android
shared storage. At 1 MiB the host rotates the file to
`miniapps.previous.jsonl`, retaining one previous file.

Event names and field keys begin with an ASCII letter and contain up to
64 letters, digits, dots, underscores or hyphens. Up to 16 optional fields
can contain strings of up to 256 characters, finite numbers, booleans or
null. A serialized record is limited to 8 KiB. Callers choose diagnostic
metadata and must keep secrets and personal data out of events.

## Events and errors

Events: `navigation.backRequested`, `permissions.changed`, `network.statusChanged`, `app.launchParamsChanged`, `storage.restored`, `app.updated`, `app.rolledBack`. Stable system errors include `feature_unavailable`, `user_gesture_required`, `network_unavailable`, `network_permission_denied`, `network_url_not_allowed`, `network_invalid_url`, `network_timeout`, `network_request_failed`, `network_request_too_large`, `network_response_too_large`, `network_redirect_blocked`, `network_tls_failed`, `notification_permission_denied`, `notification_payload_too_large`, `directory_not_found`, `file_not_found`, `file_too_large`, `file_exists`, `system_url_not_allowed`, and `system_no_handler`.

## System APIs

New manifest permissions are `network`, `notifications`, `clipboard.read`, `files.directory`, `system.open`, and `haptics`. They use the existing `mini.permissions.query()` and `mini.permissions.request()` flow and begin in `prompt` after an update. Native alert, confirm, prompt and toast require no permission. To show a
short message, call `await mini.ui.toast({ message: 'Saved' })`.

`mini.network.request(options)` is the controlled HTTP API. It requires `network` and a `network.allow` manifest list containing exact HTTPS origins or `*.example.com` subdomain patterns. HTTPS is the default; HTTP, local network addresses, and subdomains of a non-wildcard allowlist entry need their explicit manifest flags. Every redirect is checked again. The request limit is 10 MiB, response limit is 20 MiB, default timeout is 30 seconds, and at most five redirects are followed. Browser `fetch` remains unchanged and is **not** governed by this allowlist.

With `allowLocalNetwork: false`, a hostname that resolves to a mix of public
and non-public addresses is rejected with `network_url_not_allowed`. Android
and Windows use a direct connection for this API.

`mini.network.getStatus()` returns only `{ online, type, metered }`; it never exposes network names, addresses, or hardware identifiers. Android and Windows provide the controlled request API and status. Both emit `network.statusChanged` only when this normalized state changes and unregister their system listener when the mini-app closes. Windows currently reports `type: "unknown"` and `metered: false` because the WinForms host does not expose a stable richer classification.

File handles remain opaque and scoped to one mini-app. Both hosts support `files.pickMultiple`, `files.getInfo`, `files.readChunk`, `files.readTextChunk`, and `files.releaseMany`; chunks are bounded to 1 MiB. Both hosts also support user-selected directory handles: `pickDirectory`, `listDirectory`, `openInDirectory`, `createInDirectory`, `writeChunk`, `flush`, `persistDirectory`, `restoreDirectory`, and `forgetDirectory`. Directory paths must be relative and cannot contain traversal segments. The legacy whole-file methods retain their existing 5 MiB guard.

Android accepts `sequential: true` on `files.readChunk` for consecutive
ranges of a large selected file. It reads on a background worker and keeps
one input open per mini-app. Changing the file or requesting a previous
offset reopens the stream. Releasing the active file or closing the app
releases the stream.

The file cloud can call `mini.streams.open({ size, mimeType }, read)` and
`mini.streams.save({ size, mimeType, suggestedName }, read, signal)`.
The runtime exposes both capabilities only to `com.miniapps.telegram-cloud`.
Both hosts request exact blocks through `read(offset, length, signal)` and
accept sources up to 2,000,000,000 bytes. Playback requests up to 512 KiB.
Saving requests up to 1 MiB on current hosts.
`open` returns a temporary local media URL and a `close()` method.
The WebView fetches HTTP ranges from its own host process.
`save` requires `files.save` and prompts for a destination. Windows stages
the data beside the destination and commits it after the full write.
Android creates a document and attempts to delete it on a failed or cancelled
transfer. On either host, closing the app cancels the pending stream reads.

The cloud can save to a picked folder by passing a `directoryId` and optional
`folders` array of relative path segments to `mini.streams.save`. Check
`mini.runtime.supports('streams.saveInDirectory')` before calling this form.
It also requires `files.directory`. The host creates missing subdirectories
within the selected directory and saves each file separately. Folder transfers
use `files.listDirectory(id, { limit, cursor })` and pass the returned
`nextCursor` until it is null. `files.releaseDirectory(id)` drops the
window's handle after use.

Call `telegramCloud.getThumbnail` and `telegramCloud.cacheThumbnail`
through `mini.functions.call` to use the Cloud's bounded session-scoped
cache. On Windows, `telegramCloud.setToolbar` takes
`{ connected, hasChannel, channelTitle, folder, view, sort, hasTransfers }`.
It exposes the path and catalog settings. The window emits
`folder:<path>`, `view:<value>`, `sort:<value>` and `transfers`
through `ui.topBarAction`. An empty path identifies the channel root.

`telegramCloud.showContextMenu` takes `{ kind, canShare, canDownload }`.
It opens the native Windows menu at the pointer for `background`,
`file` or `selection` and returns whether it was shown. Menu commands
emit `ui.topBarAction`. Use `mini.runtime.supports` to feature-detect the
Windows methods.

`files.getAppDirectory()` returns an opaque, read-only handle for the current mini-app's installed directory. Pass that handle to `files.listAppDirectory(id, { limit })` to list up to 200 immediate entries. Folder entries return another opaque handle which can be listed recursively; file entries return regular opaque file IDs suitable for `getInfo`, `readText`, `readBase64`, `readChunk`, and `readTextChunk`. The API needs no permission, returns no OS path, follows no links outside the installed directory, and rejects writes to these file IDs with `file_read_only`.

Windows supports the same directory-handle methods. A persisted directory stores its host path privately under the user's runtime data; JavaScript receives only a new opaque directory ID after restoration. Chunk writes append at most 1 MiB and flush synchronously before resolving.

Android supports `mini.notifications.requestPermission`, `schedule`, `cancel`, `get`, `list`, and `cancelAll`. `requestPermission` uses Android's `POST_NOTIFICATIONS` prompt on Android 13+. Records are private to the manifest ID and retained after the mini-app runtime closes. Supported schedules are one-time ISO-8601 `at` timestamps, daily/weekly local-time schedules, and `interval` schedules from 15 minutes to seven days. Records are re-armed after device boot. Android alarm delivery is best-effort and system power policies can delay it. Windows notifications remain feature-unavailable.

`clipboard.readText()` requires `clipboard.read`; it returns text or `null`. `ui.alert`, `ui.confirm`, `ui.prompt`, and `ui.toast` use native UI. `haptics.*` requires `haptics` and is supported on Android only. `system.canOpenUrl`, `openUrl`, `openFile`, and `openSettings` require `system.open`; URL opening is delegated to the operating system and permits only `https`, `http`, `mailto`, `tel`, and (Android) `geo`.

Use `mini.runtime.getCapabilities()` or `mini.runtime.supports(name)` before optional APIs. Calls for an unavailable feature reject with a stable error rather than silently succeeding.

File pickers, clipboard reads, permission prompts, and external opening require a recent native user gesture on Android and Windows. Calls made outside that window reject with `user_gesture_required`.

Windows exposes `mini.files.writeChecked(id, { path, base64, expectedSha256 })`
for a single file in a user-selected directory. It requires `files.directory`.
Pass the current file's SHA-256 as 64 hexadecimal characters, or `null` to
create a file at an unused name. Writes are limited to 10 MiB. The host stages
the bytes before publishing them and reports `file_changed` on a conflict.
Use `mini.runtime.supports('files.writeChecked')` before calling it.

`mini.app.getLaunchParams()` returns the current launch context. Android returns `{ reason: "notification", notificationId, payload }` after a notification tap and emits `app.launchParamsChanged` for a running activity. Payload is JSON-only, limited to 16 KiB, and host-owned. Both hosts return `reason: "telegramSignIn"` to Unofficial Telegram during a shared sign-in. Windows returns `reason: "normal"` on regular launches. The provider reads its settings through `telegram.getSettings`. Shared sign-in always receives `testServer: false`. Writes from Unofficial Telegram return `telegram_log_disabled` when file recording is disabled in launcher settings.

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

`mini.peers` is a development-only transport. Release builds report it as
unavailable until authenticated pairing and transport protection are added.

`app.updated`, `app.rolledBack`, and `storage.restored` are reserved lifecycle events: applications should feature-detect them until the launcher emits them on both platforms.

## Local device discovery (1.5.0)

`mini.network.discoverDevices({ service, timeoutMs })` finds devices implementing the generic local discovery protocol. `mini.network.requestDevice({ id, path, method, token, body, timeoutMs })` sends bounded GET/POST requests through app-scoped endpoint capabilities. Both methods require `network`, manifest `allowHttp` and `allowLocalNetwork`, and an allowed `discoveryServices` entry. They are available in release builds and do not enable `mini.peers`. Devices, rather than the host, define command semantics. See [Local device presets](local-devices.md) for the complete contract, limits and protocol.
