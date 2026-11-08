# Local peer connections

`mini.peers` is the reserved opaque bridge for local device discovery and peer
connections. It is intentionally separate from `mini.network`: mini-app code
does not receive an IP address, network interface, port, socket, MAC address,
SSID, or a host filesystem path.

## Permission and availability

An app declares `local.peers` in its manifest and uses the normal
`mini.permissions.query('local.peers')` / `request('local.peers')` flow. The
permission is never granted automatically. The native transport is available
only in development builds. Release builds report `peers` as unavailable and
reject peer methods with `feature_unavailable`. Use
`mini.runtime.supports('peers')` before displaying peer controls.

```js
if (await mini.runtime.supports('peers')) {
  await mini.peers.startDiscovery();
  const peers = await mini.peers.list();
}
```

## JavaScript contract

The bridge provides `startDiscovery`, `stopDiscovery`, `list`, `connect`,
`disconnect`, `connections`, `openChannel`, `closeChannel`, `sendMessage`,
`sendFile`, `acceptFile`, `rejectFile`, `cancelTransfer`, and `transfers`.
All methods are Promise-based and all options are JSON-compatible. Peer events
are delivered through `mini.events`: `peers.changed`,
`peers.connectionRequested`, `peers.connectionChanged`, `peers.channelOpened`,
`peers.channelClosed`, `peers.message`, `peers.fileOffered`,
`peers.transferProgress`, `peers.transferCompleted`,
`peers.transferCancelled`, and `peers.transferFailed`.

The intended transport is mDNS/DNS-SD discovery of `_miniapps-peer._tcp.local`
and a framed local TCP connection. When a mini-app calls `startDiscovery` again
(the bundled app does this from **Refresh devices**), hosts also send a bounded
UDP fallback probe to addresses `.1` through `.200` of every active IPv4
subnet. The `MAPD1?` probe is answered unicast with a `MAPD1!` device record;
the record contains only the information needed to establish the existing TCP
connection. Logical channels are owned by
`manifest.id + channel name`; hosts must never deliver a channel's messages or
files to another mini-app. File transfers use the existing opaque file and
directory handles, native streaming, bounded chunks, and a final SHA-256
verification; Base64 is not part of the peer-transfer protocol.

The development transport currently has no authenticated pairing or encryption.
Discovery IDs and the TCP handshake do not authenticate a remote device. Do not
use it for sensitive data, even on a private network. Authenticated pairing and
transport protection are required before enabling it in release builds.

Android and Windows encode each post-handshake channel frame as a four-byte
big-endian UTF-8 JSON length followed by the JSON payload. Frames are capped at
64 KiB. The current channel operations use `channel.open`, `channel.close`, and
`message` payloads that carry the owning `appId`; a host accepts an incoming
payload only while that manifest has an active peer listener.

## Bundled demonstration

`DefaultContent/MiniApps/peer-transfer.html` is a single-file HTML demonstration mini-app. It
checks capabilities, requests `local.peers` only from its explicit button,
lists discovered devices, opens a default channel, and displays peer messages.
