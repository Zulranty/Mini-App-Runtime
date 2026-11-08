# Release readiness review — 2026-09-27

## Verified in this review

- `BuildWindows.cmd` compiled the Release host and produced `MiniAppsSetup.exe`.
  The installer staging directory contained only the executable, runtime files,
  packaged mini-app code, and packaged interfaces. It contained no `Config`,
  WebView2 profile, private data, public `storage.json`, or PDB files.
- `BuildAndroid.cmd` compiled and packaged the Release host with a temporary
  verification key. The temporary key was deleted and the previous APK in
  `Output/Android` was restored. This is a build check, not a distributable APK.
- Both hosts now require an explicit `local.peers` decision. The unauthenticated
  peer transport is disabled in Release builds.
- Windows package extraction enforces the 50 MiB unpacked limit while copying.
  Windows publish preserves installed content and restores staged user data after
  an interrupted publish.

## Required before distribution

1. Create and securely back up a permanent Android signing keystore. Supply the
   four `MINIAPPS_ANDROID_*` variables documented in [README](README.md), run
   `BuildAndroid.cmd`, and verify the certificate and update compatibility. A
   temporary or debug key is not suitable for release.
2. Perform device-level tests on supported Android versions and Windows with
   WebView2: install, upgrade, rollback, permissions, WebView navigation/frame
   isolation, file and network APIs, and preservation of data across an
   installer update. Compilation and packaging do not establish these behaviors.
3. Harden controlled network connections against DNS rebinding. Windows checks
   private IP literals but currently does not pin a vetted DNS result. Android
   resolves a hostname for the local-address check and may resolve it again for
   the actual connection. A hostname that changes to a private address between
   those steps can evade `allowLocalNetwork: false`.

The browser's own `fetch` is intentionally outside the controlled network API
and its manifest allowlist. Treat the `network` permission as permission for
`mini.network.request`, not as a sandbox for all WebView traffic.
