# Security model

Mini-app JavaScript never receives filesystem paths. The native host validates bridge parameters, manifest-relative paths and ZIP entries; traversal/Zip Slip paths are rejected. Storage and permissions are isolated by stable manifest ID.

Windows ZIP imports stream extracted files through a 50 MiB cumulative limit;
the 20 MiB archive and 1,000-entry limits are checked before or during import.
Replacing a launcher interface stages and validates its files before swapping
directories, and restores the previous interface if the final move fails.

Public storage is portable `storage.json`; private storage is local to the host; secure storage is separately encrypted and excluded from sharing and backup. A new manifest permission is left at `prompt`; removed permissions have their stored decision removed. Permission grants are never transferred to another app ID.

Install/update uses staging, validation, source preservation, atomic directory replacement, and one rollback copy outside the scanned app tree. Public storage is retained across update. A failed transition restores the previous active directory. Rollback metadata format is `miniapps-rollback`, version 1.

On Windows, rollback state is kept under `MiniApps/.runtime/rollback/<appId>/`; staging is under `MiniApps/.runtime/staging/`. These directories are excluded from the app scan. At most one previous source and application directory are retained. Rolling back swaps only application source directories: public, private, and secure user data stay at their current values.

The controlled network API is separate from browser `fetch`. Its manifest allowlist accepts explicit origins and leading subdomain wildcards only; credentials in URLs, unsafe schemes, HTTP unless opted in, and local addresses unless explicitly opted in are rejected. Redirects are checked against the same policy, cookies are not persisted by the runtime, and request/response sizes are bounded. The Android and Windows transports run outside the UI thread. Network status deliberately contains no SSID, IP, carrier, or device identifier.

File IDs are capabilities, not paths. They are opaque, app-scoped, and invalid after release or runtime destruction. System opening receives only an opaque handle or a validated URL; no filesystem path is returned to JavaScript. Clipboard reads need a separate permission. Platform dialogs render supplied strings as text rather than HTML.

The installed-directory capability is read-only and scoped to the current mini-app. It can enumerate only children of that app's installed directory and creates opaque child handles; resolved links that lead outside the directory are not exposed. It requires no user prompt because it cannot access another app or write bundled files.

Android records the last native WebView touch and requires it to be recent (one second) before permission prompts, file and directory pickers, clipboard reads, and system opening. This check is host-side; a mini-app cannot satisfy it by adding a bridge parameter.

Android mini-app HTML receives a `frame-src 'none'` content policy because
`JavascriptInterface` is available to every WebView frame. Navigation remains
inside the current mini-app origin; external URLs use `mini.system.openUrl()`.
The policy does not restrict ordinary browser `fetch` or scripts loaded by the
mini-app itself.

Windows applies the same one-second host-side check from native WebView mouse or keyboard input before permission prompts, file pickers, clipboard reads, and system opening.

Windows accepts bridge messages only from its mapped `miniapp.local` or
`launcher.local` origin, as appropriate. Mini-app navigation to another origin
is cancelled; external opening goes through the validated `mini.system` API.
Controlled network redirects on both hosts stop forwarding caller-supplied
headers after a cross-origin redirect. Android also matches the URL scheme and
a complete subdomain boundary against each manifest allowlist rule.

The local peer transport is disabled in release builds. Its development
protocol has no authenticated pairing or encryption and is not suitable for
production transfer of sensitive data.

Android notification records are scoped to the manifest ID. Their payload is JSON-only and bounded to 16 KiB; a notification tap constructs host-owned launch parameters for that same app. Removing an app cancels its alarms and clears its records and persisted directory grants. Windows does not expose notification scheduling or activation.

Generic local-device discovery additionally requires a manifest `discoveryServices` allowlist, `allowHttp`, `allowLocalNetwork`, and the existing `network` permission. The host derives addresses only from nonce-matched UDP responders on a queried private IPv4 subnet and returns app-scoped opaque endpoint capabilities with a 60-second discovery lease. Device requests permit bounded API paths, GET/POST, a restricted token header and form bodies; arbitrary URLs, cookies, proxy use and redirects are excluded. Discovery is unauthenticated and device-generated IDs are not trusted identity. Device presets must implement authorization; HTTP tokens remain plaintext and require a trusted LAN. Android uses a bounded direct socket for discovered endpoints without enabling global application or WebView cleartext access. Peer transport release gates remain unchanged.
