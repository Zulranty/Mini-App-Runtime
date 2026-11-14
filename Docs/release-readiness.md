# Release checklist

## Before distribution

1. On Windows, build with `Build\Scripts\BuildWindows.cmd`. Verify setup on a
   machine with x64 .NET 10 Desktop Runtime and WebView2. Test both a clean
   installation and an update over existing packages, permissions and data.
   See [Windows distribution](windows-distribution.md).
2. For Android, use the permanent distribution key described in
   [Requirements](README.md#requirements). Build a signed APK with
   `Build\Scripts\BuildAndroid.cmd`, or a signed AAB with
   `Build\Scripts\BuildAndroid.cmd Bundle` for Google Play. Verify that the
   release can update the intended installed version. An AAB build alone
   does not establish Play approval for shared-folder access.
3. On supported devices, test package import, updates, data preservation,
   permission prompts, browser origin isolation, file access, and controlled
   network requests. Include rollback on Windows.

## Historical verification — 2026-09-27

These results apply to the September 2026 snapshot.

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

The controlled Android and Windows clients now use the validated addresses
directly for each new connection. The TLS certificate is still checked
against the original HTTPS hostname.

The browser's own `fetch` is intentionally outside the controlled network API
and its manifest allowlist. Treat the `network` permission as permission for
`mini.network.request`, not as a sandbox for all WebView traffic.
