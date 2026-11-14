# Security model

Mini-app JavaScript never receives filesystem paths. The native host validates bridge parameters, manifest-relative paths and ZIP entries; traversal/Zip Slip paths are rejected. Storage and permissions are isolated by stable manifest ID.

Windows ZIP imports stream extracted files through a 50 MiB cumulative limit;
the 20 MiB archive and 1,000-entry limits are checked before or during import.
Replacing a launcher interface stages and validates its files before swapping
directories, and restores the previous interface if the final move fails.

Public storage is portable `storage.json`; private storage is local to the host; secure storage is separately encrypted and excluded from sharing and backup. A new manifest permission is left at `prompt`; removed permissions have their stored decision removed. Permission grants are never transferred to another app ID.

An app declaring `telegram.session` can request access to the single
`telegram.session.v1` record from `com.miniapps.telegram`. The host opens
Unofficial Telegram as the fixed sign-in provider when necessary. The provider
runs the client files and Telegram module bundled with the host. The host
loads neither its editable installed code nor the active launcher theme's
app bar into that provider. The
original WebView receives the session after native consent for that app
and that exact saved record. A consumer cannot set the sign-in result.
The file cloud keeps its existing session handoff. The cloud's encrypted
runtime state stores its fingerprint and the selected channel ID. A changed
record requires new approval. The cloud's channel and streaming methods are scoped to
`com.miniapps.telegram-cloud`. A granted session record lets the recipient
act as the signed-in Telegram account. The native prompt identifies the
requesting mini-app. Only grant it to apps and shared modules you trust.

The file cloud's temporary media URLs contain opaque random tokens and
are scoped to its current WebView. The hosts serve them locally as bounded
audio or video range responses with caching disabled. The cloud obtains
the data through its existing Telegram connection. Saving streamed data
requires the `files.save` permission and the user's native save dialog.

Install/update stages and validates app code before switching the active directory. One rollback copy is kept outside the scanned app tree. Updates and rollbacks preserve the current public storage files. Both hosts replay pending installation bookkeeping from a journal after a successful switch. If an interruption occurs before the switch, recovery restores the previous active directory. Rollback metadata format is `miniapps-rollback`, version 1.

Windows rollback state is under MiniApps/.runtime/rollback/by-id. The host
stores replacement intent under MiniApps/.runtime/package-transactions.
Close all windows of the mini-app before updating, rolling back, or deleting
it. Rollback swaps application code and preserves current user data. The host
moves a legacy rollback slot to the new location when its retained manifest
identifies the same app.

The controlled network API is separate from browser `fetch`. Its manifest allowlist accepts explicit origins and leading subdomain wildcards only; credentials in URLs, unsafe schemes, HTTP unless opted in, and local addresses unless explicitly opted in are rejected. Redirects are checked against the same policy, cookies are not persisted by the runtime, and request/response sizes are bounded. The Android and Windows transports run outside the UI thread. Network status deliberately contains no SSID, IP, carrier, or device identifier.

Android and Windows connect directly to the IP addresses returned by a single
lookup for each new connection. With `allowLocalNetwork: false`, the runtime
rejects the entire DNS result if any address is local, reserved, or multicast.
The original URL host is used for the HTTP authority and HTTPS certificate
validation. The controlled transport bypasses system HTTP proxies.

File IDs are capabilities, not paths. They are opaque, app-scoped, and invalid after release or runtime destruction. System opening receives only an opaque handle or a validated URL; no filesystem path is returned to JavaScript. Clipboard reads need a separate permission. Platform dialogs render supplied strings as text rather than HTML.

The installed-directory capability is read-only and scoped to the current mini-app. It can enumerate only children of that app's installed directory and creates opaque child handles; resolved links that lead outside the directory are not exposed. It requires no user prompt because it cannot access another app or write bundled files.

Android records the last native WebView touch and requires it to be recent (one second) before permission prompts, file and directory pickers, clipboard reads, and system opening. This check is host-side; a mini-app cannot satisfy it by adding a bridge parameter.

Android serves launcher and mini-apps under host-controlled HTTPS origins.
AndroidX WebKit accepts bridge messages from the expected origin and main
frame. Launcher and mini-app HTML are served with frame embedding disabled.
Windows also checks the origin of bridge messages and cancels navigation
away from the expected origin.

Each mini-app has a distinct origin based on its manifest ID. Windows keeps
data from the former shared browser origin separate from the new app
origins. App-native storage continues to use the installed ID. Native network
redirects on both hosts stop forwarding caller-supplied headers after a
cross-origin redirect.

The local peer transport is disabled in release builds. Its development
protocol has no authenticated pairing or encryption and is not suitable for
production transfer of sensitive data.

Android notification records are scoped to the manifest ID. Their payload is JSON-only and bounded to 16 KiB; a notification tap constructs host-owned launch parameters for that same app. Removing an app cancels its alarms and clears its records and directory aliases. Android releases a persisted system folder grant after its last alias and open runtime reference are gone. Windows does not expose notification scheduling or activation.

Generic local-device discovery additionally requires a manifest `discoveryServices` allowlist, `allowHttp`, `allowLocalNetwork`, and the existing `network` permission. The host derives addresses only from nonce-matched UDP responders on a queried private IPv4 subnet and returns app-scoped opaque endpoint capabilities with a 60-second discovery lease. Device requests permit bounded API paths, GET/POST, a restricted token header and form bodies; arbitrary URLs, cookies, proxy use and redirects are excluded. Discovery is unauthenticated and device-generated IDs are not trusted identity. Device presets must implement authorization; HTTP tokens remain plaintext and require a trusted LAN. Android uses a bounded direct socket for discovered endpoints without enabling global application or WebView cleartext access. Peer transport release gates remain unchanged.
