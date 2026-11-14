# Architecture

## Overview

Mini App Runtime has three layers:

```text
HTML mini-app or launcher interface
        │
        ├── runtime.js / launcher-runtime.js
        │
Native Android or Windows host
        │
Local mini-app files, settings, and platform services
```

Mini-app pages use `mini.*`; trusted launcher interfaces use `launcher.*`. The JavaScript bridges serialize calls to JSON messages. Each native host validates the request, performs the permitted operation, and resolves or rejects the corresponding Promise.

## Hosts

Android is a Kotlin application built with Android Gradle Plugin. It uses Android WebView, stores shared content under `/storage/emulated/0/MiniApps`, and exposes Android-specific services such as notifications, directory access, and haptics.

Windows is a .NET 10 WinForms application using WebView2. It uses virtual host mappings for local HTML content and keeps its complete runtime state next to `MiniApps.exe`. The published application is framework-dependent, single-file, and uses the system WebView2 Runtime.

## Content and installation

`DefaultContent/Interface` and `DefaultContent/MiniApps` are Windows package inputs. During publishing, launcher themes go under Interface, shared modules go under MiniApps/Modules, and bundled app archives go under Data/BundledMiniApps. On startup Windows applies those archives through the package installer.

Mini-app installation is manifest-based. The host validates a package, stages it outside the active app tree, and replaces the active directory only after validation succeeds. The stable `manifest.id` identifies the app; public `storage.json` is retained during an update. Both hosts can retain one previous package. Replacement intent is written before switching directories so interrupted changes can recover on startup.

## Trust boundaries

Mini-apps receive opaque file and directory capability IDs, never host paths. Permissions are declared in the manifest and stored per `manifest.id`. Secure storage is encrypted by the platform and is not shared or included in ordinary backups. Controlled network requests use a manifest allowlist and are separate from browser `fetch`.

A stable per-app HTTPS origin isolates browser storage. The host separately
scopes native permissions and data to the installed app ID. Android verifies
the origin and main frame of incoming bridge calls.

## Telegram integration

The native integration registers the Telegram functions used by the
bundled sign-in provider, permitted consumers and Telegram Cloud.
The provider loads its trusted package. The handler owns session consent,
connection leases and provider-specific behavior. Cloud registers its
channel, thumbnail and menu operations on the same function bridge.

The common runtime dispatches registered names and reports them through
`mini.runtime.supports`. Bundled apps call the operations through
`mini.functions.call`. The stream bridge receives deadlines for active
sources.

## Build outputs

`Build/` contains durable build configuration and scripts. `Cache/` holds regenerated outputs. `Output/` holds distributable files only. The Windows script builds the installer; the Android script builds the release APK.
