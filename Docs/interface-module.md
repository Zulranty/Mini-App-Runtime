# Interface module

The launcher interface is an externally editable HTML/CSS/JavaScript module. The runtime adds the small bridge automatically; `index.html` only needs its own markup and scripts.

On Android it is created at:

```text
/storage/emulated/0/MiniApps/Interface
```

`Interface` is a collection of launcher themes. Each subfolder is one interface and must contain `index.html`; it may be a self-contained HTML file or a set of HTML/CSS/JS files. The active interface is selected in **Settings → Interface**. ZIP and HTML files placed directly in `Interface` are scanned into interface folders; the same formats can be added through the native file picker.

The bundled `default/index.html` is self-contained: Android and Windows create only this one file for the default interface. Imported ZIP/folder interfaces may include additional files when their own `index.html` uses them.

On Windows it is created beside `MiniApps.exe` in the selected installation folder:

```text
<installation-folder>/Interface
```

The same `Interface/<name>/index.html` layout, active-interface selection, root HTML/ZIP scan, and native import are supported on Windows.

On Windows, the installer packages every interface from `DefaultContent/Interface`. Each interface is a folder with `index.html`; the default package is `DefaultContent/Interface/default/index.html`. Custom installed interface folders are preserved unless their packaged files share the same path.

If the selected interface is removed outside the runtime, the next launch automatically selects and saves the first remaining valid interface (alphabetically by folder name). A valid interface is a subfolder containing `index.html`.

## Windows launcher controls

- Click an app card to open it in the main window.
- Right-click an app card to open the launcher context menu with **Open** and **Open in new window**.
- Middle-click an app card to open it in a separate window.
- The app view in the main window provides a **← Back** button to return to the launcher.
- When an additional app window is open, closing the main window hides it in the notification area. Double-click the tray icon or choose **Open** to restore it; choose **Exit** to exit.

The built-in WebView2 context menu is disabled so it does not override the launcher menu.

## Native top bar configuration (Windows)

When an interface provides an appbar, it belongs to that interface: `Interface/<name>/appbar.js` and `Interface/<name>/appbar.css`. It is loaded into mini-apps while this interface is active; the bar itself is rendered by the Windows application.

```js
await mini.ui.setTopBar({
  height: 60,
  title: document.title,
  background: '#12141c',
  foreground: '#f6f7fb',
  accent: '#365bff',
  paddingX: 14,
  paddingY: 10,
  titleFontSize: 11,
  showBack: true,
  backText: '← Back',
  backButton: {
    radius: 20,
    paddingX: 16,
    background: '#5271ff',
    hoverBackground: '#6b86ff',
    foreground: '#ffffff',
    border: '#b7c4ff',
    borderOpacity: 105,
    fontSize: 9.5
  },
  actions: [{ id: 'save', label: 'Save', accent: true }]
});

mini.events.on('ui.topBarAction', id => {
  if (id === 'save') saveDocument();
});
```

Supported fields are `visible`, `height` (40–120 px), `paddingX`, `paddingY`, `titleFontSize`, `title`, `background`, `foreground`, `accent`, `showBack`, `backText`, `backButton`, and up to four `actions`. `backButton` controls the full back-button shape and styling: `radius`, `paddingX`, `background`, `hoverBackground`, `foreground`, `border`, `borderOpacity`, and `fontSize`. Colors must be `#RRGGBB`. The host draws it using a lightweight custom control, so the area outside its rounded shape remains the top-bar background. Use `mini.ui.hideTopBar()` to hide the bar.

Available JavaScript API:

```js
await launcher.list();
await launcher.getAppInfo(appId); // manifest, dates, and size breakdown
await launcher.open(appId);
await launcher.refresh();
await launcher.importApp();
await launcher.openNewWindow(appId); // Windows: separate window
await launcher.getInterfaceSettings(); // JSON object for the active interface, or {}
await launcher.setInterfaceSettings(settings); // JSON-compatible object
```

## Interface settings

`launcher.getInterfaceSettings()` and `launcher.setInterfaceSettings(settings)` store settings for the active launcher interface on Android and Windows. Each interface owns `Interface/<active-interface-id>/settings.json`; the native host derives this path from the selected interface, so interface JavaScript cannot choose another destination.

The getter returns `{}` when the file is absent, unreadable, malformed, or contains a non-object JSON value. The setter accepts only a JSON object, serializes at most 64 KiB (UTF-8), and replaces the file through a flushed temporary file and atomic rename. Switching interfaces changes the settings file used by subsequent calls. Removing or replacing an interface directory also removes its settings with that directory.

## Common mini-app strip

Runtime adds two standard header files to the same folder:

```text
Interface/
├─ appbar.css
└─ appbar.js
```

They automatically connect to all pages of every mini-app on Android and Windows. By default, the bar is fixed at the top of the window and contains the `← Back` button.

Clicking this button returns to the launcher: on Android it closes the current Activity mini-app, and on Windows it returns to the main window. If the mini-app was opened in a separate Windows window, the button closes this window.

Modify `appbar.js` and `appbar.css` to add any buttons, labels or custom logic to the strip. These files run in the context of each mini-app and have access to `mini.*`.

## Windows windows

A simple click on the mini-app opens it in the same main window. On Windows, you can open the application separately:

- middle mouse button on the mini-app card;
- the item `Open in new window` in the context menu of the card;
- via `await launcher.openNewWindow(appId)` in the JavaScript of the launcher interface.

## Updating an existing Interface

The Windows installer updates the interface files from `DefaultContent/Interface/`. Additional user interface folders in the installed program are not deleted; runtime does not copy the legacy template from `Code/Framework/shared/launcher-interface/`.

## System API compatibility

Interface code should call `mini.runtime.supports(name)` before presenting controls for optional system features. `mini.ui.setTopBar()` remains available on Windows. Controlled HTTP, file handles, native dialogs, clipboard reads, and external opening must use their `mini.*` APIs rather than relying on browser privileges.

Do not present notification or haptics controls in a Windows launcher interface without checking capabilities. Android notification actions may open a mini-app with `mini.app.getLaunchParams()` containing a notification ID and payload; Windows currently supplies only the normal launch context.
