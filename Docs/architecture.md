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

Windows is a .NET 8 WinForms application using WebView2. It uses virtual host mappings for local HTML content and keeps its complete runtime state next to `MiniApps.exe`. The published application is framework-dependent, single-file, and uses the system WebView2 Runtime.

## Content and installation

`DefaultContent/Interface` and `DefaultContent/MiniApps` are Windows package inputs. During publishing they become `Interface/` and `MiniApps/` beside the executable, so the Windows build remains self-contained after publication.

Mini-app installation is manifest-based. The host validates a package, stages it outside the active app tree, and replaces the active directory only after validation succeeds. The stable `manifest.id` identifies the app; public `storage.json` is retained during an update. One rollback copy may be retained by the host.

## Trust boundaries

Mini-apps receive opaque file and directory capability IDs, never host paths. Permissions are declared in the manifest and stored per `manifest.id`. Secure storage is encrypted by the platform and is not shared or included in ordinary backups. Controlled network requests use a manifest allowlist and are separate from browser `fetch`.

## Build outputs

`Build/` contains durable build configuration and scripts. `Cache/` holds regenerated outputs. `Output/` holds distributable files only. The Windows script builds the installer; the Android script builds the release APK.
