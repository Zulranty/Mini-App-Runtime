# Security model

Mini-app JavaScript never receives filesystem paths. The native host validates bridge parameters, manifest-relative paths and ZIP entries; traversal/Zip Slip paths are rejected. Storage and permissions are isolated by stable manifest ID.

Public storage is portable `storage.json`; private storage is local to the host; secure storage is separately encrypted and excluded from sharing and backup. A new manifest permission is left at `prompt`; removed permissions have their stored decision removed. Permission grants are never transferred to another app ID.

Install/update uses staging, validation, source preservation, atomic directory replacement, and one rollback copy outside the scanned app tree. Public storage is retained across update. A failed transition restores the previous active directory. Rollback metadata format is `miniapps-rollback`, version 1.

On Windows, rollback state is kept under `MiniApps/.runtime/rollback/<appId>/`; staging is under `MiniApps/.runtime/staging/`. These directories are excluded from the app scan. At most one previous source and application directory are retained. Rolling back swaps only application source directories: public, private, and secure user data stay at their current values.

The controlled network API is separate from browser `fetch`. Its manifest allowlist accepts explicit origins and leading subdomain wildcards only; credentials in URLs, unsafe schemes, HTTP unless opted in, and local addresses unless explicitly opted in are rejected. Redirects are checked against the same policy, cookies are not persisted by the runtime, and request/response sizes are bounded. The Android and Windows transports run outside the UI thread. Network status deliberately contains no SSID, IP, carrier, or device identifier.

File IDs are capabilities, not paths. They are opaque, app-scoped, and invalid after release or runtime destruction. System opening receives only an opaque handle or a validated URL; no filesystem path is returned to JavaScript. Clipboard reads need a separate permission. Platform dialogs render supplied strings as text rather than HTML.

The installed-directory capability is read-only and scoped to the current mini-app. It can enumerate only children of that app's installed directory and creates opaque child handles; resolved links that lead outside the directory are not exposed. It requires no user prompt because it cannot access another app or write bundled files.

Android records the last native WebView touch and requires it to be recent (one second) before permission prompts, file and directory pickers, clipboard reads, and system opening. This check is host-side; a mini-app cannot satisfy it by adding a bridge parameter.

Windows applies the same one-second host-side check from native WebView mouse or keyboard input before permission prompts, file pickers, clipboard reads, and system opening.

Android notification records are scoped to the manifest ID. Their payload is JSON-only and bounded to 16 KiB; a notification tap constructs host-owned launch parameters for that same app. Removing an app cancels its alarms and clears its records and persisted directory grants. Windows does not expose notification scheduling or activation.
