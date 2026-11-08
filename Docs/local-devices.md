# Local device presets

Runtime 1.5.0 provides generic LAN discovery and HTTP requests to discovered devices.
Device-specific commands, presentation, pairing and firmware belong to a mini-app
and its device preset. The host has no knowledge of lighting or board models.
This API is available in release builds and does not enable `mini.peers`.

## Manifest and permission

```json
{
  "permissions": ["network"],
  "network": {
    "allow": [],
    "allowHttp": true,
    "allowLocalNetwork": true,
    "discoveryServices": ["my-device"]
  }
}
```

`discoveryServices` contains up to eight service names matching
`[a-z][a-z0-9-]{0,47}`. Empty HTTP origin lists are accepted when a valid
discovery service is declared. Existing HTTP origin rules continue to apply
to `mini.network.request`; discovered devices do not add general URL access.

Both local-device methods require the normal `network` permission. An app can
check the stored decision at launch and immediately discover if it is granted.
For the first use, provide a user control that calls discovery: the host shows
its permission dialog before network access. Never grant permissions silently.

## Bridge

```js
if (await mini.runtime.supports('network.discoverDevices')) {
  const devices = await mini.network.discoverDevices({
    service: 'my-device', timeoutMs: 2500
  });
  // [{ id, deviceId, name, service }]
  if (devices.length === 1) {
    const response = await mini.network.requestDevice({
      id: devices[0].id, path: '/api/state', method: 'GET',
      token: savedToken, timeoutMs: 4000
    });
    // { status, ok, body: { encoding: 'text', data: '...' } }
  }
}
```

`id` is an opaque capability owned by this app view. It expires 60 seconds after
the last successful discovery and never exposes an address or port. Rediscover
every 20 seconds while connected. `deviceId` is an untrusted device-generated
32-character lowercase hex identifier, useful for reconnecting to a previously
selected device; it must not be treated as authenticated identity.

Discovery returns up to 64 matching responders for the current query, including
all available interfaces. An empty result means no device replied. Timeout is
1000–5000 ms (default 2500). One discovery can run per app view. It binds to up to
eight active private IPv4 interfaces, sends directed broadcasts and, on /24 or
smaller subnets, performs a paced unicast fallback over all usable addresses.
There is no fixed `.1`–`.200` cutoff. Larger subnets require broadcast delivery.
Windows discovery disables UDP `PORT_UNREACHABLE` error reporting on its probe
socket: closed ports on other hosts must not stop reception of device replies.
Guest-network isolation, VLAN boundaries, firewalls and disabled broadcasts can
prevent discovery even when two devices use the same router. IPv6-only and public
address LANs are not supported by this protocol.

Requests permit GET and POST, timeout 1–10000 ms (default 4000), a relative path
matching `/api/[a-zA-Z0-9_/-]{1,80}` (no `//`), and an optional form-encoded string
`body` up to 4096 UTF-8 bytes. GET bodies are rejected. The optional `token` is
32 lowercase hex characters and is sent as `X-Device-Token`. POST uses
`application/x-www-form-urlencoded; charset=utf-8`. No redirects, cookies, proxy,
arbitrary headers or caller URLs are supported. Response body limit is 64 KiB.
The Android reader also limits response headers to 8 KiB. Devices must return
HTTP/1.0 or HTTP/1.1 with one `Content-Length`, without chunked transfer encoding.
App close cancels discovery/request resources and invalidates capabilities.

Errors include `network_url_not_allowed`, `invalid_params`, `network_unavailable`,
`discovery_busy`, `device_busy`, `device_not_found`, `network_timeout`,
`network_request_failed`, `network_redirect_blocked`, `network_response_invalid`
and `network_response_too_large`. HTTP failures such as 401 are returned as
responses; the mini-app decides how to handle them.

## Device discovery protocol v1

Device listens on UDP **42101**. Datagrams are ASCII with exactly one space between
fields, without a trailing newline. Runtime creates a fresh 32-character lowercase
hex nonce per discovery and sends:

```text
MINIAPP_DEVICE/1? <nonce> <service>
```

A matching device replies **from port 42101**, unicast to the sender's address and
ephemeral port:

```text
MINIAPP_DEVICE/1! <nonce> <service> <deviceId> <httpPort> <name>
```

`httpPort` is 1–65535. `name` matches `[A-Za-z0-9_-]{1,48}`. Reply size is at most
256 bytes. The host validates nonce, service, sender port and membership in the
queried private IPv4 subnet, and derives the endpoint exclusively from the packet
sender. The packet cannot supply a URL or an alternate host. Discovery is not
authenticated: device-level pairing and authorization still belong to the preset.

HTTP transport is plaintext and is intended for a trusted local network. Tokens
authorize commands but do not provide encryption or protection from an active
LAN attacker. Pairing secrets should be stored with `mini.secureStorage`, never
portable/public storage. Android uses a bounded direct socket for this endpoint
capability; the application and WebView cleartext policy remains disabled.

## Verification

Build Windows with `Build\Scripts\BuildWindows.cmd`, then run
`Build\Scripts\TestLocalDevices.cmd Windows` against its actual compiled service.
`Build\Scripts\TestLocalDevices.cmd Android` runs JVM tests of the production
Kotlin service and manifest parser without creating or signing an APK. These
tests use real UDP and TCP simulators on an active private IPv4 interface;
absence of that interface is a setup failure, not a successful skip. Android APK
distribution still requires the configured permanent signing credentials.

For a locally installable APK without production credentials, use
`Build\Scripts\BuildAndroid.cmd Local`. The SDK signs it automatically with its
persistent debug certificate; the artifact is `Output/Android/MiniApps-local.apk`.
This still uses the release build type, so development-only peer transport stays
disabled. The default build continues to require the configured permanent key.
