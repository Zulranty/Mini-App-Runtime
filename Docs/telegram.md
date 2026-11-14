# Shared modules and Telegram

## Shared JavaScript modules

Ordinary consumers such as Shopping List and Telegram Cloud load the
shared Telegram module from the installed `MiniApps` directory. To replace
this copy, put its files in the directory shown below, then reopen the
consumer. The host loads **Unofficial Telegram**, the sign-in provider, and
its Telegram module from the host bundle. Editing files under `MiniApps`
changes the shared copy for ordinary consumers only.

```text
MiniApps/
└── Modules/
    └── telegram/
        ├── index.js
        └── THIRD-PARTY.txt
```

Windows uses the `MiniApps` subfolder beside `MiniApps.exe`. Android uses
`/storage/emulated/0/MiniApps`. The Windows installer and Android APK include
the shared module, **Unofficial Telegram**, Telegram Cloud and Shopping List.
Both hosts apply their bundled mini-apps on startup after installation or an update. Shopping List includes English and Russian
entries in the same package and keeps the existing list on update. On both
platforms, **Settings → Telegram** also offers manual installation of the
bundled client and module with progress and a restart prompt.

```js
await mini.modules.load('telegram');
const telegram = window.MiniAppTelegram;
```

Module IDs match `[a-z][a-z0-9-]{0,47}`. The host serves only the classic script
entry point, up to 16 MiB. Concurrent loads of the same ID share one promise in a document.
An unavailable script rejects with `module_load_failed` and can be retried.
The script publishes its own API on `window`. Reopen the mini-app after
replacing an already loaded module. An invalid ID rejects with `invalid_module_id`.

A module executes in the calling app's document with the same bridge permissions
as that app. It can see its page and any data the app can access. Treat shared
module files as executable code and install them from a source you trust.

## Sign in and use Telegram

1. Create Telegram API credentials under **API development tools** on
   [my.telegram.org](https://my.telegram.org). See [Telegram's API ID instructions](https://core.telegram.org/api/obtaining_api_id).
2. Open **Unofficial Telegram** in MiniApps and enter your API ID and API hash.
   For phone login, also enter the phone number in international format. If
   Telegram sends an in-app code, look for it in the verified **Telegram**
   service chat on a device signed in with the same number. When Telegram
   offers SMS as a fallback, **Запросить код по SMS** becomes available after
   the wait period. **Ответ Telegram** on the code screen shows the delivery
   type, the fallback offered by Telegram, and its timeout in seconds. These
   fields describe the server response. Check the receiving device to confirm
   the message arrived. Use QR sign-in if the message does not arrive and
   Telegram offers no fallback.
   See [Telegram's login code help](https://telegram.org/faq#q-getting-a-code-via-telegram).
   If Telegram switches delivery after a resend, use the new prompt. A code
   can arrive by email, and Telegram can ask you to verify a new address.
   The email screen offers a reset when Telegram provides reset availability
   and shows the waiting date when a reset is pending.
3. For QR login, choose **Войти по QR** on the sign-in or code screen. On a
   signed-in phone, open **Settings → Devices → Link Desktop Device** in
   Telegram and scan the displayed QR code. The code is generated locally and
   changes when it expires. MiniApps checks the login again when the code
   refreshes and when you return to it on Android. This lets it pick up the
   confirmation and show the two-step verification password prompt if the
   scan notification arrived late.
   See [Telegram's QR login flow](https://core.telegram.org/api/qr-login).
4. Open a chat to load and mark the displayed messages as read. Use **Обновить**
   to fetch new messages, **Загрузить предыдущие** for older history and
   **Отправить** to send a text message. The mini-app supports personal chats and
   groups. Attachments appear as placeholders. Broadcast channels require
   sponsored-message support under [Telegram's API terms](https://core.telegram.org/api/terms).

The module uses [teleproto](https://github.com/sanyok12345/teleproto) over secure
WebSocket connections to Telegram data centers. This is the browser's WebSocket
transport. The app's Content Security Policy limits its network connections to
`wss://*.web.telegram.org`.

### Test server

In the launcher, open **Settings → Telegram** and enable **Telegram test server**.
Then open **Unofficial Telegram** directly. Use an account registered in Telegram's separate test
environment, for example one open in Telegram Beta with **Test Backend**
enabled. Enter the code from a test session or scan the QR with that session.
The same bundled or manually supplied API credentials can be used in both
environments. See [Telegram's test environment](https://core.telegram.org/bots/features#dedicated-test-environment).

The test mode has its own saved session, re-entry tokens, service notices and
rate-limit deadline. The client verifies the test server before requesting a
code. The setting is off by default and applies the next time you open
Unofficial Telegram. Turn it off to return to the regular server.
Sign-in opened by the shopping list or file cloud continues to use the
regular account.

Unofficial Telegram sends the host's Windows or Android version and the
installed client version in the MTProto connection metadata. The connection
sends `en-US` as `system_lang_code`. The sign-in log includes the OS and
client versions in `telegram.connection.profile`.

### Sign-in log

Before requesting a login code or using QR, enable **Save Telegram login log
to file** in the launcher under **Settings → Telegram**. After the attempt,
open **Telegram login log** in the same tab to view or copy the latest 80
recorded Telegram login events. These include the platform, connection,
data center, request timing, Telegram response, and QR progress. Use
**Refresh log** to reload the display. File recording is off by default.
Turning it off leaves existing logs in place. On
Windows, find it under `Data/User/Logs` in the MiniApps installation. On
Android, open `Documents/MiniApps/Logs` in shared storage.
The export contains no phone number, API credentials, login code, QR token,
password, session, or raw Telegram payload. The log can confirm an RPC response.
The response exposes Telegram's selected delivery method, and the API
provides no confirmation that the receiving app displayed the message.

With **Сохранить сеанс на этом устройстве** selected, the mini-app encrypts the
API credentials and session through `mini.secureStorage`. Opening Unofficial
Telegram restores the saved session for the selected server automatically. An
expired session opens the sign-in form. After a temporary connection error,
choose **Повторить подключение** to try the saved session again. Login codes and the
two-step verification password are used during sign-in. When Telegram issues
a future authorization token, MiniApps keeps it in the same protected storage
under a separate key. It supplies saved tokens for the current API ID on
subsequent phone sign-ins when **Сохранить сеанс на этом устройстве** is
selected. Telegram decides whether to accept a token and whether to request
the two-step verification password. MiniApps keeps up to 20 tokens in total.
**Выйти** ends the Telegram session and keeps the tokens for the next login.
**Удалить сохранённый вход** removes the local session and tokens. After
logging out, use **Удалить токены повторного входа** to remove the tokens
separately. Use Telegram's device settings to revoke a session when Telegram
does not confirm logout.

Unofficial Telegram shows unconfirmed devices and lets you confirm or revoke
each new session. Login codes in the service chat are hidden from chat
previews. On Android 14 and later, a screenshot detected by the system while
the chat is visible requests invalidation of visible login codes. Windows
and older Android versions protect the chat window from ordinary OS capture.

Install the current MiniApps host together with the Telegram module and both
mini-apps. One Telegram window in an installation can connect at a time.
Close the connected window to use the saved profile from the other mini-app.
This keeps the saved login available for the next window.
The installation keeps Telegram's rate-limit deadline across window closes.
If the server returns a wait, the current queue pauses and resumes after the
specified time. The app displays the wait and keeps file saves cancellable.
Telegram service notices are shown in the current mini-app and kept in the
encrypted local history for Telegram Notifications.

## Bundle API credentials

For a build that should use a predefined Telegram API ID and hash, copy
`Build/Telegram/api-credentials.example.json` to
`Build/Telegram/api-credentials.local.json` and fill in `api_id` and
`api_hash`. Build Windows or Android with the usual platform script.
The local file is excluded from Git. The credentials are part of the
resulting distribution and can be extracted by someone who receives it.

Unofficial Telegram uses valid bundled credentials for new sign-ins and
offers a button for manual entry. When the file is absent, malformed,
or rejected by Telegram, the login screen shows the API ID and hash
fields. A saved account continues using the credentials with which it
signed in. Telegram login codes, passwords, and sessions stay out of
the build file.

## Sign in from another mini-app

Open the Telegram feature in the requesting mini-app and choose its sign-in
button. If the runtime has no saved account, it opens **Unofficial Telegram**.
Use the instructions under **Как получить API ID и API hash** to get the
developer credentials. Sign in by QR or phone. MiniApps saves the session,
closes the sign-in window, and asks whether the original mini-app may use the
saved account. Later apps can use that same account after their own approval.

## Sync the Shopping List

1. Create a private broadcast channel for the list, with auto-delete and
   content protection off. Give both Telegram accounts permission to post.
2. Open **Shopping List → Settings → Telegram sync → Connect Telegram**.
   You can also open setup with **Sync** at the top of the list if no channel
   is selected. Sign in if prompted, search for the channel by name, and select
   **Use this channel**. The app checks posting access, auto-delete and content
   protection before saving the channel. Repeat on the second device with the
   other account and the same channel. To switch later, select **Change channel**.
3. Select **Sync** at the top of the app. A new channel receives the current
   list. When joining an existing channel, the app imports the shared list
   and merges local edits. Local shopping continues when signed out or offline.

The mini-app searches the selected channel for `#miniapps_shopping_list`.
One Telegram post contains the selected purchases and purchase marks in its
caption, with a JSON attachment for synchronization. If the caption reaches
Telegram's limit, the attachment still contains the complete shared list.
The attachment includes stable IDs, the latest change to each shared field,
and removal records. An unchanged shared list can reuse the existing post.
One sync downloads up to 8 MiB of unique shopping-list snapshots. If the
channel exceeds that budget, the app reports the limit and keeps the local list.

Each device keeps its product catalog, category layout and appearance settings
locally. Received purchases appear in the normal **Purchases** list and add
any missing products or categories to **Goods**. Matching catalog products
reflect the shared selection and purchase marks. Removing a purchase clears
its selection and keeps the product in the catalog. Matching names within
the same category are combined, and removal records keep an offline copy
from restoring a previously removed purchase.

Sync reads the current purchase JSON attachment. Earlier text snapshots and
full-catalog attachments are skipped and stay in the channel.

After the first successful channel lookup, Shopping List remembers the selected
channel for the current Telegram login. Later syncs go straight to that channel
and recheck its settings and posting rights. If Telegram rejects the saved
channel reference, or the user signs in again, the app looks up the channel in
the dialogs and refreshes the reference.

The app writes and confirms a merged snapshot before cleaning up older
snapshots that it contains. Cleanup verifies that the retained publication
still exists. Each account deletes only its own older snapshots. An older
publication by another participant stays in the channel until that person
selects **Sync**. Simultaneous writes can also leave several valid snapshots
until the next sync. Leave at least one valid
list publication in the channel to preserve changes for offline devices.

## Schedule messages

Open **Unofficial Telegram** in MiniApps and sign in to your personal account.
In **Запланировать**, enter text, use **Прикрепить файлы** for documents,
select the chats, and set the send time in your device's time zone. Use
**Добавить день** to schedule the same message and files on more dates.
The button starts with the next calendar day, and you can edit each date
individually. Every selected day uses the same local clock time.
Search includes archived dialogs and Saved Messages. The app supports
personal chats, groups and channels where you have posting rights.
Review the dates, time and recipients in the confirmation dialog. Telegram stores
each confirmed schedule and sends it even after MiniApps closes.

A batch can target up to 10 chats and create up to 30 deliveries. Each
chat on each day counts as one delivery. You can attach up to 10 nonempty
files of up to 2 GB each, subject to Telegram's account and chat limits. Several
files form one grouped document message. The app allows up to 4096 text
characters or 1024 for an attachment caption. Leave time for the upload and
the batch. Each scheduling request needs at least 45 seconds of lead time
to avoid Telegram's immediate-send window. If Telegram reports a wait that
would push the request past that margin, the batch stops. The result lists
the outcome for each chat and date. Retrying the current draft submits
only deliveries that were rejected or still pending. If authentication expires
mid-batch, the open window keeps the draft and confirmed results for the same
Telegram account and server. If Telegram did not
confirm a delivery, check the queue before planning it in a new draft.

In **Отложенные**, the app checks each accessible dialog, including the
archive, for messages in Telegram's queue. This includes schedules created
in other Telegram clients. Cancel a single message or document group, a
chat's queue, or all checked queues. The last two actions refresh the
relevant queues before confirmation. Unavailable or unverified chats are
reported separately. **Остановить проверку** stops the queue scan.

The dialog list is cached in the connected window for two minutes and
per-chat queue snapshots for one minute. An explicit refresh revalidates
queues using Telegram's history hashes. Scheduled-message updates refresh
the visible cache and invalidate the affected snapshot. The app keeps
queue contents and attachment handles in memory. It uploads each
selected file once per batch, uses sequential requests and applies
Telegram's reported flood and slow-mode waits. A server spam or account
restriction stops the scheduling batch and blocks further scheduling in
that connection. Use the feature for chats expecting your messages and
follow [Telegram's spam rules](https://telegram.org/faq_spam).

To get an updated scheduling client, install a MiniApps build containing the
new bundled provider. The app requests the native file-picker permission
when you attach a file.

## Use a private channel as a file drive

1. Sign in to **Unofficial Telegram** with **Сохранить сеанс на этом устройстве**
   selected. Open **Облако файлов** in the same MiniApps installation, choose
   **Использовать сохранённый вход** and allow access in the MiniApps dialog.
   After approval, the cloud opens the saved account and last selected
   channel automatically. A changed saved session requires fresh approval.
   If the session expired, sign in again in Unofficial Telegram.
2. Open **Выбрать канал** in the three-dot menu and search by channel name.
   Select a private broadcast channel you own or administer with posting rights.
   The full-width catalog loads more entries as you scroll, including documents
   and photos. A caption such as `Folder^asdf^IMG.jpg` places `IMG.jpg` in
   `Folder/asdf`. The app also reads caret paths from filenames without
   captions and folder-only captions with a slash or backslash from earlier
   builds. A plain caption leaves the attachment in the channel root.
3. The toolbar path starts with the channel name. Select it to return to
   the root or select a folder in the path to go up. **Назад** dismisses
   the open menu or dialog first. In the catalogue it goes up one folder.
   From the root or the initial screen it returns to the MiniApps launcher.
   Use **Вид** and
   **Сортировка** in the three-dot menu to change the catalog. The catalog sorts the
   loaded entries by name, date or size, with folders before files. Filenames
   and the size/date labels use fixed-height single lines. Hover over a
   card for its full name. Each vertical mouse wheel signal scrolls the
   catalog by one row. For staggered tiles, a row is a group of as many
   consecutive cards as there are columns. The catalog animates wheel
   movement even when system animations are disabled. Tiles
   show thumbnails embedded in Telegram messages or available in the local
   cache as soon as the tiles enter view. A sharper thumbnail replaces the
   first frame in the background. The app reuses the media reference from
   the loaded catalogue and refreshes the message only if the reference
   expires. Both tile views place each card in the shortest
   column and repack the cards when the window width or a preview size
   changes. Each tile's preview area follows the thumbnail's proportions
   and shows the whole frame edge to edge. When Telegram offers
   both resized and square-cropped thumbnails, the app prefers a resized
   frame. It caches up to 256
   thumbnails on disk, scoped to the approved saved session. Protected
   thumbnails stay in memory. Auto-deleting messages are excluded from the
   cloud catalogue and thumbnail cache.
   If Telegram provides no usable thumbnail, the app can generate one
   from a supported image up to 32 MiB when its tile enters view. Other
   entries display file-type icons. Open a file for a larger preview.
   The header shows the Telegram post date alongside the filename and size
   when the timestamp is available.
   The viewer first shows a cached or embedded thumbnail when available.
   It replaces that image after decoding the original in the background
   for supported images up to 64 MiB.
   While the original loads, the status appears beside the preview title
   without changing the height of the image area. The viewer shows decoded
   portions of JPEG, PNG and WebP over the cached or embedded thumbnail as
   bytes arrive, when supported by the WebView. WebP partial frames require
   the WebCodecs image decoder. Other WebViews show the thumbnail until the
   full WebP loads. Undecoded areas with no thumbnail pixels are black.
   Progressive JPEGs can gain detail across the whole frame.
   For larger images and other documents, it uses the available Telegram
   thumbnail, including embedded low-resolution thumbnails.
   A large text file shows its first 64 KiB. Video and audio use the
   device's web player and request ranges as playback or seeking needs them.
   Images and video fill the available window while preserving their
   proportions, including when enlarged. The toolbar icon switches to
   original preview dimensions and back. Larger media can scroll in
   original-size mode. Use the left and right arrows or swipe horizontally
   to browse the loaded images and videos in the current folder, in its
   current sort order. Zoom the media with the wheel or a pinch. Ctrl+wheel
   follows the host's interface zoom. Drag enlarged media
   with the left mouse button or a finger to pan it. Videos start on open
   and a click or tap on the picture toggles play and pause. If autoplay
   with sound is blocked, the player
   starts muted and the toolbar offers a sound button.
   Playback depends on the formats and codecs supported by WebView or
   WebView2. **Скачать на устройство** saves files up to 2 GB in parts.
   Protected content has a preview and the save action is unavailable.
4. **Загрузить файлы** posts the files you select directly to the open cloud
   folder. For a supported image up to 64 MiB, the app generates a JPEG
   thumbnail up to 320 px on the long edge and attaches it to the same
   Telegram document as the unchanged original. The catalogue can load
   that thumbnail directly. The viewer still opens the original when
   available. You can also drag files and folders into the cloud window. The
   drop indicator shows the destination and files inside dropped folders keep
   their relative paths. Empty folders can be added with **Создать папку**.
   On Android, the file manager and WebView must support external file drops.
   **Загрузить папку** creates a subfolder with the source folder's name
   and preserves the paths of its files. **Создать папку** saves an empty folder
   in the selected channel so it can be reopened and used as an upload destination.
   The folder menu opens from the three-dot button or by right-clicking empty space.
   Each uploaded file must be
   nonempty and at most 2 GB (2,000,000,000 bytes). The app reads the file
   in ranges and follows the account's Telegram upload limits. For files of
   at least 16 MiB, it uploads up to four parts at once using Telegram's
   maximum upload part size of 512 KiB. If a batch
   stops partway through, the queue retains the files awaiting confirmation.
   The app checks channel history before sending and skips files with the same
   destination folder, name, and byte size. A match can also come from a file
   already published earlier in the same batch.
   The catalogue, upload check, folder picker and download preparation share
   the same history pages in memory, including pages still being fetched.
   Channel updates and confirmed writes update the cache. If upload
   confirmation is lost, the next check refreshes the recent history.
5. **Скачать папку** saves the contents of the open folder, including nested
   files from older entries, to a directory you select. Transfers use up to
   2 GB per file and report skipped protected files and failed saves.
   Downloads to disk use 1 MiB blocks from Telegram and write as data arrives.
6. Right-click or hold a file to rename it, move it, delete it, or forward
   its message to a Telegram chat. Renaming and moving store the new cloud
   path in the Telegram caption and retain the previous caption text. These
   actions require permission to edit the original post. Deletion asks for
   confirmation and removes the post from the channel. Telegram's forwarding
   restrictions apply to protected files. Use the checkboxes next to the
   dates to select several files in the same folder, then open the menu on one
   of them to move, delete, forward, or download the selection to a directory.
7. **Передача** in the three-dot menu opens while a download or an upload is
   active, or when an interrupted upload is waiting to be retried. One upload
   and one download can run at the same time. Select the direction when both
   are present. The progress bar uses the number of files processed, including
   the current file's partial progress. Downloads first collect the file list
   to determine the total. **Повторить** continues the pending upload queue
   in the current window and checks again for existing files before sending.

The cloud borrows the saved account from the same MiniApps installation.
The runtime remembers approval for that exact session and the selected
channel. If there is no saved account, the cloud sign-in button opens Unofficial Telegram and returns after login. Closing the cloud disconnects its current window from Telegram.

## Rebuild the module

Run `Build\Telegram\BuildModule.cmd` from the repository root with Node.js and
npm installed. It uses the pinned lockfile to regenerate the browser bundle
and its third-party notices. The build adds a range reader and a large-part
option to the pinned Teleproto uploader while retaining checksums and retries.
The host build scripts use the checked-in bundle.
