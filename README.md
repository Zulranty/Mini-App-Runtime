# Mini App Runtime

**Create personal applications with AI and run them immediately—without manual programming, compilation, or app store publishing.**

Mini App Runtime runs local applications written in HTML, CSS, and JavaScript on Android and Windows.

A person can give the Mini App Runtime documentation to an AI model, describe the application they need in plain language, and receive a ready-to-use HTML file or ZIP archive. Once imported, the application appears in the launcher and is ready to run.

```text
Describe the application
          ↓
AI creates HTML, CSS, and JavaScript
          ↓
Import the HTML file or ZIP archive
          ↓
The application works immediately
```

There is no need to:

* learn programming;
* install a development environment;
* build an APK or EXE;
* configure a server;
* pay for hosting;
* publish the application in an app store;
* go through app store review;
* install a separate native application for every small task.

## The Main Idea

Most people do not need universal applications containing hundreds of features.

They often need something small and personal:

* a shopping list adapted to their family’s habits;
* a personal expense tracker;
* a work-time and earnings calculator;
* a workout journal;
* a medication planner;
* a household inventory;
* a habit tracker;
* a tool for a specific job;
* a small editor;
* a local game;
* an application created for one device or one specific task.

Previously, this required a programmer, or the user had to adapt their needs to an existing application.

Now the user can describe the task to an AI:

```text
Create a family shopping list application.

It should support categories, product quantities, a dark theme,
sorting, and data import and export.

The application must run in Mini App Runtime.
Here is the runtime documentation: ...
```

The AI creates the application, while Mini App Runtime provides the execution environment and access to system features.

## This Is Not a Built-In App Builder

Mini App Runtime does not generate applications itself and is not tied to any particular AI model.

It defines a documented application format and provides a JavaScript API. An application can be created by any tool capable of writing HTML, CSS, and JavaScript:

* ChatGPT;
* Codex;
* Claude;
* Gemini;
* a local language model;
* a traditional developer;
* a visual or automated code-generation tool.

The AI receives the runtime documentation and produces files that can be imported immediately.

## Why Not Just Use a Browser?

Browsers already execute HTML, CSS, and JavaScript. However, a normal web page runs inside a restricted browser environment.

It does not provide a consistent and reliable way to:

* store private application data separately from other websites;
* work with files and directories selected by the user;
* save files through native system dialogs;
* read the clipboard;
* create persistent notifications;
* use haptic feedback;
* open system applications;
* handle Android Back and Windows Escape consistently;
* request native permissions;
* install and update local applications;
* share an application as a single file;
* use the same system API on Android and Windows.

Mini App Runtime adds a controlled native bridge:

```js
await mini.storage.private.set('items', items);

const file = await mini.files.pick({
  mimeTypes: ['application/json']
});

await mini.share.text('Shopping list');

await mini.ui.toast('Saved');
```

A mini-app remains a normal HTML application, but it gains access to approved operating-system features.

## What the User Gets

### Applications Work Immediately

No compilation is required.

A mini-app can be distributed as:

* a single HTML file;
* a ZIP archive;
* a ready-to-use application directory.

After import, it appears in the launcher.

### Applications Can Remain Local

A mini-app can work entirely without a server or internet connection.

Its data remains on the user’s device. Network access is only necessary for applications that actually need it.

### Applications Are Easy to Share

A created application can be sent to friends, relatives, or colleagues.

The runtime can produce:

* a standalone HTML file for a self-contained application;
* a ZIP archive containing the application files;
* a separate export of public user data.

Application code and user data are shared separately. Private and secure data are not included in a normal application export.

### Applications Can Be Modified with AI

The user can give an existing HTML file or application source code to an AI and request changes:

```text
Add a light theme.

Make the categories draggable.

Add JSON export.

Fix Back-button behavior on Android.
```

The modified application can then be imported again. The runtime identifies it by its permanent `manifest.id` and updates the installed application while preserving its data.

## The Launcher Interface Can Also Be Created with AI

The launcher interface is not hardcoded into the native application.

It is a separate HTML, CSS, and JavaScript module:

```text
Interface/
└── my-interface/
    ├── index.html
    ├── appbar.js
    ├── appbar.css
    └── settings.json
```

A user can describe the desired interface to an AI:

```text
Create a Mini App Runtime interface inspired by Windows 8.

Applications should be displayed as colored tiles.

Add settings for the number of columns, light and dark themes,
an accent color, and an application information menu.
```

The generated interface can be imported in the same way as a mini-app.

Different users can create their own launcher interfaces without changing the native Android or Windows code.

## Mini-App Capabilities

Mini App Runtime provides a unified asynchronous `mini.*` API.

| API                    | Purpose                                     |
| ---------------------- | ------------------------------------------- |
| `mini.app`             | Current application information and control |
| `mini.runtime`         | Runtime version and capability detection    |
| `mini.navigation`      | Android Back and Windows Escape handling    |
| `mini.events`          | Runtime events                              |
| `mini.permissions`     | Application permissions                     |
| `mini.storage.private` | Private application data                    |
| `mini.storage.public`  | Portable public data                        |
| `mini.secureStorage`   | Encrypted secrets                           |
| `mini.files`           | Files and user-selected directories         |
| `mini.clipboard`       | Clipboard reading and writing               |
| `mini.share`           | Native text and file sharing                |
| `mini.network`         | Controlled HTTP requests                    |
| `mini.notifications`   | Notifications and schedules                 |
| `mini.ui`              | Native dialogs, toasts, and top bar         |
| `mini.system`          | Opening URLs, files, and system settings    |
| `mini.haptics`         | Haptic feedback                             |

Not every capability is available on every platform. Applications can check whether a feature is supported:

```js
if (await mini.runtime.supports('notifications.schedule')) {
  await mini.notifications.schedule({
    id: 'daily-reminder',
    title: 'Reminder',
    body: 'Check your task list',
    daily: {
      hour: 9,
      minute: 0
    }
  });
}
```

## Platforms

| Capability                     | Android | Windows |
| ------------------------------ | :-----: | :-----: |
| HTML and ZIP applications      |    ✅    |    ✅    |
| Private/Public Storage         |    ✅    |    ✅    |
| Secure Storage                 |    ✅    |    ✅    |
| Files and selected directories |    ✅    |    ✅    |
| Controlled HTTP requests       |    ✅    |    ✅    |
| Clipboard read/write           |    ✅    |    ✅    |
| Native dialogs and toasts      |    ✅    |    ✅    |
| Opening URLs and files         |    ✅    |    ✅    |
| Persistent notifications       |    ✅    |    —    |
| Haptic feedback                |    ✅    |    —    |
| Separate application windows   |    —    |    ✅    |
| Editable launcher interface    |    ✅    |    ✅    |

Applications should not rely only on the platform name. Optional capabilities must be checked through `mini.runtime.supports()` or `mini.runtime.getCapabilities()`.

## Quick Start

A minimal application consists of two files:

```text
hello-app/
├── manifest.json
└── index.html
```

### `manifest.json`

```json
{
  "id": "com.example.hello",
  "name": "Hello App",
  "version": "1.0.0",
  "sdkVersion": 2,
  "minRuntimeVersion": "1.4.0",
  "entry": "index.html",
  "description": "My first mini-app",
  "permissions": ["storage"]
}
```

### `index.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >
  <title>Hello App</title>
</head>
<body>
  <h1>My Application</h1>

  <input id="text" placeholder="Enter some text">
  <button id="save">Save</button>

  <script>
    const input = document.querySelector('#text');
    const saveButton = document.querySelector('#save');

    async function initialize() {
      input.value =
        await mini.storage.private.get('text') ?? '';
    }

    saveButton.addEventListener('click', async () => {
      await mini.storage.private.set('text', input.value);
      await mini.ui.toast('Saved');
    });

    initialize();
  </script>
</body>
</html>
```

The runtime injects the JavaScript bridge automatically. No system script needs to be included manually.

Place the files in a ZIP archive with `manifest.json` at the root, then import the archive through the launcher.

## Single-File HTML Applications

For small applications, the manifest can be embedded directly into the HTML document:

```html
<script type="application/miniapp+json">
{
  "id": "com.example.counter",
  "name": "Counter",
  "version": "1.0.0",
  "sdkVersion": 2,
  "minRuntimeVersion": "1.4.0",
  "permissions": ["storage"]
}
</script>
```

The resulting file can be imported directly into Mini App Runtime or sent to another person.

This format is particularly convenient for AI-generated applications: all code, styles, and manifest information can be stored in one file.

## Example AI Prompt

```text
Create a complete single-file HTML application for Mini App Runtime.

Purpose:
Track work time and earned money.

Features:
- start and stop a timer;
- configurable hourly rate;
- statistics for today and the current month;
- persistent data storage;
- light and dark themes;
- correct Android Back and Windows Escape handling;
- JSON data export.

Use Runtime API v2.
Check optional features with mini.runtime.supports().
Embed the manifest using application/miniapp+json.
Return one complete HTML file without external dependencies.

Mini App Runtime documentation:
[paste the documentation here]
```

## Permissions

A system capability is available to an application only when:

1. its permission is declared in the manifest;
2. the capability is supported on the current platform;
3. the user has allowed its use;
4. the native host validates the request.

Example manifest section:

```json
{
  "permissions": [
    "storage",
    "clipboard.read",
    "clipboard.write",
    "files.pick",
    "files.save",
    "files.directory",
    "share",
    "network",
    "notifications",
    "system.open",
    "haptics"
  ]
}
```

Permissions added during an application update are not granted automatically.

## Storage

The runtime separates application data into three areas:

| Storage | Purpose                   | Included in Data Export |
| ------- | ------------------------- | :---------------------: |
| Public  | Portable user data        |            ✅            |
| Private | Local application state   |            —            |
| Secure  | Tokens, keys, and secrets |            —            |

```js
await mini.storage.private.set('theme', 'dark');

await mini.storage.public.set('shoppingList', [
  {
    name: 'Milk',
    completed: false
  }
]);

await mini.secureStorage.set('accessToken', token);
```

Data belonging to different applications is isolated by the permanent `manifest.id`.

## Application Format

A regular application may contain multiple files:

```text
my-app/
├── manifest.json
├── index.html
├── app.js
├── style.css
└── assets/
    └── icon.png
```

Minimal manifest:

```json
{
  "id": "com.example.myapp",
  "name": "My App",
  "version": "1.0.0",
  "sdkVersion": 2,
  "entry": "index.html"
}
```

The runtime supports:

* ZIP archives with `manifest.json` at the root;
* ready-to-use application directories;
* HTML files with an embedded manifest;
* regular HTML files for which the manifest is created during import.

## Installation and Updates

An application is identified by its `manifest.id`.

During an update:

* application code is replaced;
* public data is preserved;
* private and secure storage remain attached to the application ID;
* newly declared permissions are set to `prompt`;
* installation is performed through a staging area;
* a failed update should not destroy the working version;
* the runtime may retain one previous application version for rollback.

Application versions use Semantic Versioning:

```text
1.0.0
1.1.0
2.0.0-beta.1
```

## Sharing Applications

The launcher can export application code and public data separately.

### Application Code

* a single HTML file for a self-contained application;
* a ZIP archive for a multi-file application.

User data is not included in the application package.

### Public Data

The application’s `storage.json` can be exported separately and sent to another user.

Private Storage and Secure Storage are never exported.

This makes it possible to:

* send an application to a relative;
* share a tool with a colleague;
* distribute an application template without personal data;
* transfer public settings or content separately;
* update application code without mixing it with user information.

## Security Model

A mini-app does not receive unrestricted access to the file system.

The runtime exposes controlled system APIs:

* JavaScript receives opaque file handles instead of real paths;
* file handles are isolated by application ID;
* ZIP entries are checked for path traversal and Zip Slip;
* system permissions are validated by the native host;
* Secure Storage is encrypted using operating-system facilities;
* HTTP requests can be restricted through an allowlist;
* redirects are checked against the same network policy;
* request, response, and file sizes are limited;
* sensitive actions require a recent user gesture;
* permissions are not transferred between different application IDs.

Mini App Runtime does not make arbitrary HTML completely trustworthy. Applications should only be imported when the user understands their origin or can inspect their source code.

## Working Directories

### Android

```text
/storage/emulated/0/MiniApps/
├── Interface/
├── .runtime/
└── <installed-app>/
```

### Windows

```text
<installation-folder>/
├── MiniApps.exe
├── MiniApps/
├── Interface/
├── Config/
└── Data/
```

The Windows version uses the Microsoft Edge WebView2 Runtime installed on the system and does not bundle its own copy of Chromium.

## Building the Runtime

### Android

Requirements:

* JDK 17 or newer;
* Android SDK Platform 35;
* the Gradle Wrapper included in the repository.

```bat
build\Scripts\BuildAndroid.cmd
```

Output:

```text
Output/Android/MiniApps.apk
```

### Windows

Requirements:

* .NET SDK 8 or newer;
* Inno Setup 6;
* Microsoft Edge WebView2 Runtime for running the application.

```bat
build\Scripts\BuildWindows.cmd
```

Output:

```text
Output/Windows/MiniAppsSetup.exe
```

Both platforms can be built with one command:

```bat
build\Scripts\BuildAll.cmd
```

## Documentation

* [`Docs/architecture.md`](Docs/architecture.md) — architecture and repository layout;
* [`Docs/mini-app-format.md`](Docs/mini-app-format.md) — application format and manifest;
* [`Docs/runtime-api.md`](Docs/runtime-api.md) — the `mini.*` JavaScript API;
* [`Docs/interface-module.md`](Docs/interface-module.md) — creating launcher interfaces;
* [`Docs/mini-app-management.md`](Docs/mini-app-management.md) — installation, sharing, and rollback;
* [`Docs/launcher-management.md`](Docs/launcher-management.md) — trusted launcher operations;
* [`Docs/security-model.md`](Docs/security-model.md) — security model;
* [`Docs/windows-build.md`](Docs/windows-build.md) — Windows build details;
* [`Docs/windows-distribution.md`](Docs/windows-distribution.md) — Windows distribution.

When working with AI, users can provide a combined documentation file or only the sections relevant to the application being created.

## Current Status

Runtime version: `1.4.0`
Supported SDK version: `2`

The main Android and Windows functionality is already implemented:

* local application installation;
* the JavaScript bridge;
* storage APIs;
* permissions;
* file APIs;
* controlled network requests;
* native dialogs;
* launcher interfaces;
* application import and export.

Some capabilities still differ between platforms. Applications should use feature detection and continue working correctly when an optional capability is unavailable.

The project is under active development.

## Project Goal

Mini App Runtime aims to make personal application development accessible to people who do not know how to program.

The user describes a task in ordinary language. AI creates the application. The runtime launches it immediately and provides access to device capabilities.

An application does not need to become a product for millions of people.

Sometimes it only needs to help one person, one family, or one small group—and that is enough.
