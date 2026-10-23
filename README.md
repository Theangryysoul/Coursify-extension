# Coursify Chrome extension

**Developer:** Jerry  
**Developer email:** theangryysoul@gmail.com

A standalone Manifest V3 extension for **https://getcoursify.vercel.app**, requiring **Chrome 123 or newer**. No build step, dependencies, or changes to the Coursify frontend/backend are required.

## Install in Google Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Extract `Coursify-extension.zip`, then select the extracted folder containing `manifest.json`.
   Select the folder itself, not `manifest.json` or the ZIP file.
5. Optionally pin **Coursify YouTube Import** using Chrome's puzzle-piece menu.

After editing extension files, press **Reload** on its card at `chrome://extensions`. Refresh any Coursify tabs after reloading the extension.

## Import a course

- Right-click a YouTube video thumbnail/title link or playlist link and select **Import course**.
- Links work on YouTube and on other pages linking to YouTube.
- On a YouTube watch/playlist page, right-click the page background and select **Import course**.
- Alternatively, open a YouTube video/playlist and click the extension icon, then **Import current YouTube page**.
- Supported links: watch videos, playlists, `youtu.be`, Shorts, live, and embed URLs. Shorts/live/embed links are converted to watch URLs accepted by the existing backend.
- **A link with a `list` parameter imports the entire playlist**, matching Coursify's existing import behavior. Use a video link without `list` to import only that video.

Chrome and YouTube both have video-player menus. If YouTube's own player menu appears first, right-click again to get Chrome's menu, or use the video title/thumbnail link, page background, or toolbar button.

### Already logged in

The extension uses an existing Coursify tab to refresh your session and import through the existing API. It does not navigate that tab or the YouTube tab.

If no Coursify tab is open, it opens a temporary **inactive** Coursify tab. After the import completes, that temporary tab closes automatically, unless you made it active. Chrome needs a page on the Coursify origin to send the website's HTTP-only, `SameSite=Strict` cookie; a background service-worker request would not reliably reuse it. No passwords or tokens are copied into extension storage.

### Login required

The extension opens **https://getcoursify.vercel.app/login** in a new active tab (or activates its temporary tab). Sign in with password or Google, or register using Coursify's normal page. After Coursify navigates away from the login/register screen, the extension automatically resumes the pending import.

Keep that login tab open until the import finishes. The YouTube tab is never navigated. Existing Coursify work tabs are not redirected. If you close the login tab, use **Retry import** from the extension popup.

### Check progress

Click the extension icon to see the last import's status, URL, and server error if any. Its badge shows:

- `…`: importing
- `IN`: waiting for login
- `OK`: imported
- `!`: failed or interrupted

The popup includes **Continue to login**, **Cancel pending import**, **Retry import**, and **Open Coursify library**, as appropriate. Imports run one at a time. Cancellation is available only while waiting for login; it cannot undo an API request that has already started.

The backend handles private/unavailable playlists, API quota/rate limits, and duplicate imports. These responses are shown in the popup. An already-imported video may return “Course already exists in your library.” An already-imported playlist may return success because the backend reuses the existing course.

An already open library page may need a refresh to show a newly imported course; the extension deliberately does not reload or modify the app UI. If an import times out or Chrome interrupts it, check the library before retrying—it may have completed on the server. Reopen the popup after three minutes to recover an interrupted job.

## Permissions and privacy

- **contextMenus**: adds the right-click import option.
- **scripting** and the single **Coursify host permission**: run same-origin API requests on Coursify. Requests use `/api/v1/auth/refresh` and `/api/v1/youtube/import`, matching the app.
- **storage**: stores only the latest import URL/status, job/tab identifiers, timestamps, and returned course ID in `chrome.storage.local`. It does not use Chrome sync and stores no password, access token, refresh token, or profile.
- **activeTab**: reads the current page URL when you explicitly use the toolbar button.
- The Coursify content script only detects navigation away from login while an import is pending. It does not read forms, capture credentials, or modify the page.
- No third-party services, remote scripts, YouTube API keys, or broad browsing-history permissions are used. Import requests go only to the specified Coursify deployment.

## Verification

From the extracted extension folder, run:

```sh
node --test tests/*.test.js
```

Tests use mocked Chrome APIs and mocked API responses; they do not log in or create real courses.

Manual Chrome checklist:

1. Load unpacked and check that the extension card has no errors.
2. While logged into Coursify, import a new video from its right-click link menu. Confirm `OK`, no tab redirection, and a new course in the library after refreshing it.
3. Import a playlist, then a Shorts or `youtu.be` link. Check the resulting course types.
4. Close all Coursify tabs but remain logged in. Import again; confirm the temporary inactive tab closes and YouTube stays active.
5. Log out of Coursify. Import a different video; confirm the login tab opens and importing resumes automatically after password/Google login.
6. Close a pending login tab and retry from the popup. Test cancelling a pending login as well.
7. Import a duplicate video and an unavailable/private playlist; confirm useful backend messages appear.
8. Try an unsupported link and rapid repeated imports; confirm they do not issue unwanted requests.

This folder is a locally loadable extension, not a Chrome Web Store publication. No deployment or server restart is needed.
